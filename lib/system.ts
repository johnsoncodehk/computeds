export interface IEffect {
	nextNotify: IEffect | undefined;
	notify(): void;
}

export interface Dependency {
	subs: Link | undefined;
	subsTail: Link | undefined;
	depVersion: number;
	subVersion: number;
	update?(): void;
	notifyLostSubs?(): void;
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
	isScope?: boolean;
}

export interface Link {
	dep: Dependency;
	depVersion: number;
	sub: Subscriber & ({} | IEffect | Dependency);
	prevSubOrUpdate: Link | undefined;
	nextSub: Link | undefined;
	nextDep: Link | undefined;
	prevPropagateOrNextReleased: Link | undefined;
}

export const enum DirtyLevels {
	NotDirty,
	MaybeDirty,
	Dirty,
}

export namespace System {

	export let activeSub: Subscriber | undefined = undefined;
	export let activeSubsDepth = 0;
	export let batchDepth = 0;
	export let subVersion = DirtyLevels.Dirty + 1;
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
			} else {
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
			pool = link.prevPropagateOrNextReleased;
			link.prevPropagateOrNextReleased = undefined;
			link.dep = dep;
			link.sub = sub;
			return link;
		} else {
			return {
				dep,
				depVersion: -1,
				sub,
				prevSubOrUpdate: undefined,
				nextSub: undefined,
				nextDep: undefined,
				prevPropagateOrNextReleased: undefined,
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
		unlinkSub(link);
		// @ts-ignore
		link.dep = undefined;
		link.prevPropagateOrNextReleased = pool;
		pool = link;
	}

	export function unlinkSub(link: Link) {
		const dep = link.dep as Dependency & ({} | Subscriber);
		const nextSub = link.nextSub;
		const prevSub = link.prevSubOrUpdate;

		if (nextSub !== undefined) {
			nextSub.prevSubOrUpdate = prevSub;
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = nextSub;
		}

		if (nextSub === undefined) {
			dep.subsTail = prevSub;
		}
		if (prevSub === undefined) {
			dep.subs = nextSub;
		}

		// @ts-ignore
		link.sub = undefined;
		link.prevSubOrUpdate = undefined;
		link.nextSub = undefined;

		if (dep.subs === undefined && dep.notifyLostSubs !== undefined) {
			dep.notifyLostSubs();
		}
	}
}

export namespace Dependency {

	const system = System;

	export function link(dep: Dependency, allowScope: boolean) {
		if (system.activeSubsDepth === 0) {
			return;
		}
		const sub = system.activeSub!;
		if (!allowScope && sub.isScope) {
			return;
		}
		const subVersion = sub.versionOrDirtyLevel;
		if (dep.subVersion === subVersion) {
			return;
		}
		dep.subVersion = subVersion;

		const depsTail = sub.depsTail;
		const old = depsTail !== undefined
			? depsTail.nextDep
			: sub.deps;

		if (old === undefined || old.dep !== dep) {
			const newLink = Link.get(dep, sub);
			newLink.depVersion = dep.depVersion;
			if (old !== undefined) {
				newLink.nextDep = old;
			}
			if (depsTail === undefined) {
				sub.depsTail = sub.deps = newLink;
			} else {
				sub.depsTail = depsTail.nextDep = newLink;
			}
			if (dep.subs === undefined) {
				dep.subs = newLink;
				dep.subsTail = newLink;
			} else {
				const oldTail = dep.subsTail!;
				newLink.prevSubOrUpdate = oldTail;
				oldTail.nextSub = newLink;
				dep.subsTail = newLink;
			}
		} else {
			old.depVersion = dep.depVersion;
			sub.depsTail = old;
		}
	}

	export function propagate(dep: Dependency) {
		dep.depVersion++;

		let link = dep.subs;
		let dirtyLevel = DirtyLevels.Dirty;
		let depth = 0;

		top: while (true) {

			while (link !== undefined) {
				const sub = link.sub;
				const subDirtyLevel = sub.versionOrDirtyLevel;

				if (subDirtyLevel < dirtyLevel) {
					sub.versionOrDirtyLevel = dirtyLevel;
				}

				if (subDirtyLevel === DirtyLevels.NotDirty) {

					if ('subs' in sub) {
						sub.deps!.prevPropagateOrNextReleased = link;
						dep = sub;
						link = sub.subs;
						dirtyLevel = DirtyLevels.MaybeDirty;
						depth++;

						continue top;
					}

					if ('notify' in sub) {
						const queuedEffectsTail = system.queuedEffectsTail;

						if (queuedEffectsTail !== undefined) {
							queuedEffectsTail.nextNotify = sub;
							system.queuedEffectsTail = sub;
						} else {
							system.queuedEffectsTail = sub;
							system.queuedEffects = sub;
						}
					}
				}

				link = link.nextSub;
			}

			const depDeps = (dep as Dependency & Subscriber).deps;
			if (depDeps !== undefined) {

				const prevLink = depDeps.prevPropagateOrNextReleased;

				if (prevLink !== undefined) {
					depDeps.prevPropagateOrNextReleased = undefined;
					dep = prevLink.dep;
					link = prevLink.nextSub;
					depth--;

					if (depth === 0) {
						dirtyLevel = DirtyLevels.Dirty;
					}

					const prevSub = prevLink.sub;

					if ('notify' in prevSub) {
						const queuedEffectsTail = system.queuedEffectsTail;

						if (queuedEffectsTail !== undefined) {
							queuedEffectsTail.nextNotify = prevSub;
							system.queuedEffectsTail = prevSub;
						} else {
							system.queuedEffectsTail = prevSub;
							system.queuedEffects = prevSub;
						}
					}

					continue;
				}
			}

			break;
		}
	}
}

export namespace Subscriber {

	const system = System;

	export function relinkDeps(sub: Subscriber) {
		let link = sub.deps;

		top: while (true) {

			while (link !== undefined) {
				const dep = link.dep as Dependency | Dependency & Subscriber;

				if (dep.subs === undefined) {
					dep.subs = link;
					dep.subsTail = link;
				} else {
					const oldTail = dep.subsTail!;
					link.prevSubOrUpdate = oldTail;
					oldTail.nextSub = link;
					dep.subsTail = link;
				}
				link.sub = sub;

				if (dep.depVersion !== link.depVersion) {
					link.depVersion = dep.depVersion;
					sub.versionOrDirtyLevel = DirtyLevels.Dirty;
				} else if ('deps' in dep) {
					if (dep.update !== undefined) {
						if (dep.versionOrDirtyLevel === DirtyLevels.MaybeDirty) {
							dep.subs!.prevSubOrUpdate = link;
							sub = dep;
							link = dep.deps;

							continue top;
						} else if (dep.versionOrDirtyLevel === DirtyLevels.Dirty) {
							dep.update();

							if (dep.depVersion !== link.depVersion) {
								sub.versionOrDirtyLevel = DirtyLevels.Dirty;
							}
						}
					}
				}

				link = link.nextDep;
			}

			const dirtyLevel = sub.versionOrDirtyLevel;

			if (dirtyLevel === DirtyLevels.MaybeDirty) {
				sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
			}

			const subSubs = (sub as Dependency & Subscriber).subs;
			if (subSubs !== undefined) {

				const prevLink = subSubs.prevSubOrUpdate;

				if (prevLink !== undefined) {
					if (dirtyLevel === DirtyLevels.Dirty) {
						(sub as Dependency & Subscriber).update!();

						if ((sub as Dependency & Subscriber).depVersion !== prevLink.depVersion) {
							prevLink.sub.versionOrDirtyLevel = DirtyLevels.Dirty;
						}
					}

					subSubs.prevSubOrUpdate = undefined;
					sub = prevLink.sub as Dependency & Subscriber;
					link = prevLink.nextDep;

					continue;
				}
			}

			break;
		}
	}

	export function resolveMaybeDirty(sub: Subscriber) {
		let link = sub.deps;
		let hasDirtyInnerEffects = false;

		top: while (true) {

			while (link !== undefined) {
				const dep = link.dep as Dependency | Dependency & Subscriber;

				if ('deps' in dep) {
					if (dep.update !== undefined) {
						const depDirtyLevel = dep.versionOrDirtyLevel;

						if (depDirtyLevel === DirtyLevels.MaybeDirty) {
							dep.subs!.prevSubOrUpdate = link;
							sub = dep;
							link = dep.deps;

							continue top;
						} else if (depDirtyLevel === DirtyLevels.Dirty) {
							dep.update();

							if ((sub.versionOrDirtyLevel as DirtyLevels) === DirtyLevels.Dirty) {
								break;
							}
						}
					} else if ('notify' in dep) {
						const depDirtyLevel = dep.versionOrDirtyLevel;

						if (depDirtyLevel === DirtyLevels.MaybeDirty || depDirtyLevel === DirtyLevels.Dirty) {
							hasDirtyInnerEffects = true;
						}
					}
				}

				link = link.nextDep;
			}

			const dirtyLevel = sub.versionOrDirtyLevel;

			if (dirtyLevel === DirtyLevels.MaybeDirty) {
				sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
			}

			const subSubs = (sub as Dependency & Subscriber).subs;
			if (subSubs !== undefined) {

				const prevLink = subSubs.prevSubOrUpdate;

				if (prevLink !== undefined) {
					if (dirtyLevel === DirtyLevels.Dirty) {
						(sub as Dependency & Subscriber).update!();
					}

					subSubs.prevSubOrUpdate = undefined;
					sub = prevLink.sub as Dependency & Subscriber;
					link = prevLink.nextDep;

					continue;
				}
			}

			break;
		}

		if (hasDirtyInnerEffects && sub.versionOrDirtyLevel === DirtyLevels.NotDirty) {
			let link = sub.deps;

			while (link !== undefined) {
				const dep = link.dep as Dependency | Dependency & Subscriber & IEffect;
				if ('notify' in dep && dep.versionOrDirtyLevel !== DirtyLevels.NotDirty) {
					dep.notify();
				}
				link = link.nextDep;
			}
		}
	}

	export function startTrack(sub: Subscriber) {
		const lastActiveSub = system.activeSub;
		system.activeSub = sub;
		system.activeSubsDepth++;
		sub.versionOrDirtyLevel = system.subVersion++;
		preTrack(sub);
		return lastActiveSub;
	}

	export function endTrack(sub: Subscriber, lastActiveSub: Subscriber | undefined) {
		postTrack(sub);
		sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
		system.activeSubsDepth--;
		system.activeSub = lastActiveSub;
	}

	export function clearTrack(sub: Subscriber) {
		preTrack(sub);
		postTrack(sub);
	}

	function preTrack(sub: Subscriber) {
		sub.depsTail = undefined;
	}

	function postTrack(sub: Subscriber) {
		if (sub.depsTail !== undefined) {
			Link.releaseDeps(sub.depsTail);
		} else if (sub.deps !== undefined) {
			Link.releaseDeps(sub.deps);
			Link.release(sub.deps);
			sub.deps = undefined;
		}
	}
}
