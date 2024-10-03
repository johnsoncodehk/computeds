export interface IEffect {
	nextNotify: IEffect | undefined;
	notify(): void;
}

export interface Dependency {
	subs: Link | undefined;
	subsTail: Link | undefined;
	subVersion: number;
}

export interface Subscriber {
	/**
	 * Represents either the version or the dirty level of the dependency.
	 * 
	 * - When tracking is active, this property holds the version number.
	 * - When tracking is not active, this property holds the dirty level.
	 */
	versionOrDirtyLevel: number | DirtyLevels;
	deps: Link | undefined;
	depsTail: Link | undefined;
	prevUpdate: Link | undefined;
	run(): void;
}

export interface Link {
	dep: Dependency;
	sub: Subscriber & ({} | IEffect | Dependency);
	prevSub: Link | undefined;
	nextSub: Link | undefined;
	nextDep: Link | undefined;
	nextPropagateOrReleased: Link | undefined;
}

export const enum DirtyLevels {
	NotDirty,
	QueryingDirty,
	MaybeDirty,
	Dirty,
}

export namespace System {

	export let activeSub: Subscriber | undefined = undefined;
	export let activeSubsDepth = 0;
	export let batchDepth = 0;
	export let subVersion = 0;
	export let queuedEffects: IEffect | undefined = undefined;
	export let queuedEffectsTail: IEffect | undefined = undefined;

	export function startBatch() {
		batchDepth++;
	}

	export function endBatch() {
		batchDepth--;
		while (batchDepth === 0 && queuedEffects !== undefined) {
			const effect = queuedEffects;
			const queuedNext = queuedEffects.nextNotify;
			if (queuedNext !== undefined) {
				queuedEffects.nextNotify = undefined;
				queuedEffects = queuedNext;
			}
			else {
				queuedEffects = undefined;
				queuedEffectsTail = undefined;
			}
			effect.notify();
		}
	}
}

export namespace Link {

	let pool: Link | undefined = undefined;

	export function get(dep: Dependency, sub: Subscriber): Link {
		if (pool !== undefined) {
			const link = pool;
			pool = link.nextPropagateOrReleased;
			link.nextPropagateOrReleased = undefined;
			link.dep = dep;
			link.sub = sub;
			return link;
		} else {
			return {
				dep,
				sub,
				prevSub: undefined,
				nextSub: undefined,
				nextDep: undefined,
				nextPropagateOrReleased: undefined,
			};
		}
	}

	export function releaseDeps(toBreak: Link) {
		let nextDep = toBreak.nextDep;
		while (nextDep !== undefined) {
			toBreak.nextDep = undefined;
			const nextNext = nextDep.nextDep;
			Link.release(nextDep);
			toBreak = nextDep;
			nextDep = nextNext;
		}
	}

	export function release(link: Link) {
		const nextSub = link.nextSub;
		const prevSub = link.prevSub;

		if (nextSub !== undefined) {
			nextSub.prevSub = prevSub;
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = nextSub;
		}

		if (nextSub === undefined) {
			link.dep.subsTail = prevSub;
		}
		if (prevSub === undefined) {
			link.dep.subs = nextSub;
		}

		// @ts-ignore
		link.dep = undefined;
		// @ts-ignore
		link.sub = undefined;
		link.prevSub = undefined;
		link.nextSub = undefined;
		link.nextDep = undefined;

		link.nextPropagateOrReleased = pool;
		pool = link;
	}
}

export namespace Dependency {

	const system = System;

	export function link(dep: Dependency) {
		if (system.activeSubsDepth === 0) {
			return;
		}
		const sub = system.activeSub!;
		if (dep.subVersion === sub.versionOrDirtyLevel) {
			return;
		}
		dep.subVersion = sub.versionOrDirtyLevel;

		const old = sub.depsTail !== undefined
			? sub.depsTail.nextDep
			: sub.deps;

		if (old === undefined || old.dep !== dep) {
			const newLink = Link.get(dep, sub);
			if (old !== undefined) {
				const nextDep = old.nextDep;
				Link.release(old);
				newLink.nextDep = nextDep;
			}
			if (sub.depsTail === undefined) {
				sub.depsTail = sub.deps = newLink;
			}
			else {
				sub.depsTail = sub.depsTail!.nextDep = newLink;
			}
			if (dep.subs === undefined) {
				dep.subsTail = dep.subs = newLink;
			}
			else {
				newLink.prevSub = dep.subsTail;
				dep.subsTail = dep.subsTail!.nextSub = newLink;
			}
		}
		else {
			sub.depsTail = old;
		}
	}

	export function propagate(dep: Dependency) {
		let dirtyLevel = DirtyLevels.Dirty;
		let currentSubs = dep.subs;
		let lastSubs = currentSubs!;

		while (currentSubs !== undefined) {
			let subLink: Link | undefined = currentSubs;

			while (subLink !== undefined) {
				const sub = subLink.sub;
				const subDirtyLevel = sub.versionOrDirtyLevel;

				if (subDirtyLevel === DirtyLevels.NotDirty) {
					if ('subs' in sub && sub.subs !== undefined) {
						lastSubs = lastSubs.nextPropagateOrReleased = sub.subs;
					}
					if ('notify' in sub) {
						if (system.queuedEffectsTail !== undefined) {
							system.queuedEffectsTail = system.queuedEffectsTail.nextNotify = sub;
						}
						else {
							system.queuedEffects = system.queuedEffectsTail = sub;
						}
					}
				}

				if (subDirtyLevel < dirtyLevel) {
					sub.versionOrDirtyLevel = dirtyLevel;
				}

				subLink = subLink.nextSub;
			}

			dirtyLevel = DirtyLevels.MaybeDirty;
			const nextPropagate = currentSubs.nextPropagateOrReleased;
			currentSubs.nextPropagateOrReleased = undefined;
			currentSubs = nextPropagate;
		}
	}
}

export namespace Subscriber {

	const system = System;

	export function confirmDirtyLevel(sub: Subscriber) {
		let link = sub.deps;

		top: while (true) {

			if (sub.versionOrDirtyLevel === DirtyLevels.MaybeDirty) {
				while (link !== undefined) {
					const dep = link.dep as Dependency | Dependency & Subscriber;

					if ('deps' in dep && dep.versionOrDirtyLevel >= DirtyLevels.MaybeDirty) {
						dep.prevUpdate = link;
						sub = dep;
						link = dep.deps;

						continue top;
					}

					link = link.nextDep;
				}
			}

			const prevLink = sub.prevUpdate;

			if (sub.versionOrDirtyLevel === DirtyLevels.MaybeDirty) {
				sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
			}

			if (prevLink !== undefined) {
				if (sub.versionOrDirtyLevel === DirtyLevels.Dirty) {
					sub.run();
				}

				sub.prevUpdate = undefined;
				sub = prevLink.sub;
				link = prevLink.nextDep;

				continue top;
			}

			break;
		}
	}

	export function startTrack(sub: Subscriber) {
		const lastActiveSub = system.activeSub;
		system.activeSub = sub;
		system.activeSubsDepth++;
		Subscriber.preTrack(sub);
		return lastActiveSub;
	}

	export function endTrack(sub: Subscriber, lastActiveSub: Subscriber | undefined) {
		Subscriber.postTrack(sub);
		system.activeSubsDepth--;
		system.activeSub = lastActiveSub;
	}

	export function preTrack(sub: Subscriber) {
		sub.depsTail = undefined;
		sub.versionOrDirtyLevel = system.subVersion++;
	}

	export function postTrack(sub: Subscriber) {
		if (sub.depsTail !== undefined) {
			Link.releaseDeps(sub.depsTail);
		}
		else if (sub.deps !== undefined) {
			Link.releaseDeps(sub.deps);
			Link.release(sub.deps);
			sub.deps = undefined;
		}
		sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
	}
}
