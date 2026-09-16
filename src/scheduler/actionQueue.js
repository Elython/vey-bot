/**
 * Priority Action Queue for Sequencing Bot Actions
 * Higher priority actions (e.g. emergency heal) execute before regular attacks or looting.
 */

const Priority = {
  EMERGENCY: 100, // Healing, panic escape
  COMBAT: 70,    // Skills, basic attack
  TARGETING: 50, // Select monster
  LOOTING: 30,   // Pick up item/chest
  EXPLORATION: 10, // Move, next room
};

class ActionQueue {
  constructor(timingEngine) {
    this.timingEngine = timingEngine;
    this.queue = [];
    this.isProcessing = false;
    this.isPaused = false;
    this.onActionExecuted = null;
    this.onError = null;
  }

  /**
   * Enqueues an action with a given priority
   * @param {Object} action
   * @param {string} action.id - Unique or descriptive ID
   * @param {string} action.type - Action type (e.g., 'HEAL', 'ATTACK', 'TARGET', 'LOOT')
   * @param {Function} action.execute - Async function to run
   * @param {number} [action.priority=Priority.COMBAT]
   * @param {number} [action.customDelayMin]
   * @param {number} [action.customDelayMax]
   */
  enqueue(action) {
    const item = {
      id: action.id || `action_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: action.type || 'UNKNOWN',
      execute: action.execute,
      priority: action.priority ?? Priority.COMBAT,
      customDelayMin: action.customDelayMin,
      customDelayMax: action.customDelayMax,
      createdAt: Date.now(),
    };

    // Insert sorted descending by priority
    const index = this.queue.findIndex((q) => q.priority < item.priority);
    if (index === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(index, 0, item);
    }

    return item.id;
  }

  /**
   * Clears all pending actions in queue
   */
  clear() {
    this.queue = [];
  }

  /**
   * Removes a specific action by ID
   * @param {string} id
   */
  remove(id) {
    this.queue = this.queue.filter((q) => q.id !== id);
  }

  /**
   * Pauses action processing
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * Resumes action processing
   */
  resume() {
    this.isPaused = false;
  }

  /**
   * Returns current queue size
   * @returns {number}
   */
  get size() {
    return this.queue.length;
  }

  /**
   * Pops and executes the next highest-priority action with randomized timing
   * @returns {Promise<any>}
   */
  async processNext() {
    if (this.isPaused || this.queue.length === 0) {
      return null;
    }

    const action = this.queue.shift();
    try {
      const result = await action.execute();

      // Anti-detection random pacing after action execution
      if (this.timingEngine) {
        await this.timingEngine.sleepRandom(action.customDelayMin, action.customDelayMax);
      }

      if (this.onActionExecuted) {
        this.onActionExecuted(action, result);
      }
      return result;
    } catch (err) {
      if (this.onError) {
        this.onError(action, err);
      }
      throw err;
    }
  }
}

module.exports = { ActionQueue, Priority };
