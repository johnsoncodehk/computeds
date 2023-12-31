import { DirtyLevels, activeTrackers, cleanupDepEffect, depsMap, pauseTracking, resetTracking } from './system';

export type TrackToken = WeakRef<Tracker> | Tracker;

export class Tracker {

	trackToken?: TrackToken;
	dirtyLevel = DirtyLevels.Dirty;
	trackId = 0;
	runnings = 0;
	queryings = 0;
	depsLength = 0;

	constructor(
		public spread: () => void,
		public effect?: () => void,
	) { }

	get dirty() {
		if (this.dirtyLevel === DirtyLevels.ComputedValueMaybeDirty) {
			this.dirtyLevel = DirtyLevels.NotDirty;
			if (this.trackToken) {
				const deps = depsMap.get(this.trackToken);
				if (deps) {
					this.queryings++;
					pauseTracking();
					for (const dep of deps) {
						if (dep.computed) {
							dep.computed();
							if (this.dirtyLevel >= DirtyLevels.ComputedValueDirty) {
								break;
							}
						}
					}
					resetTracking();
					this.queryings--;
				}
			}
		}
		return this.dirtyLevel >= DirtyLevels.ComputedValueDirty;
	}

	track<T>(fn: () => T): T {
		try {
			activeTrackers.push(this);
			this.runnings++;
			preCleanup(this);
			return fn();
		} finally {
			postCleanup(this);
			this.runnings--;
			activeTrackers.pop();
			if (!this.runnings) {
				this.dirtyLevel = DirtyLevels.NotDirty;
			}
		}
	}

	reset() {
		preCleanup(this);
		postCleanup(this);
		this.dirtyLevel = DirtyLevels.Dirty;
	}

	deref() {
		return this;
	}
}

function preCleanup(tracker: Tracker) {
	tracker.trackId++;
	tracker.depsLength = 0;
}

function postCleanup(tracker: Tracker) {
	if (tracker.trackToken) {
		const deps = depsMap.get(tracker.trackToken);
		if (deps && deps.length > tracker.depsLength) {
			for (let i = tracker.depsLength; i < deps.length; i++) {
				cleanupDepEffect(deps[i], tracker);
			}
			deps.length = tracker.depsLength;
		}
	}
}
