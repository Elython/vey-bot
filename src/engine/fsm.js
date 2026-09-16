/**
 * Finite State Machine (FSM) for Bot Decision Flow
 */

const BotState = {
  STOPPED:         'STOPPED',         // Bot is not running
  IDLE:            'IDLE',            // Bot started, deciding what to do
  SCANNING_GATES:  'SCANNING_GATES',  // Fetching active gates + wave monsters
  JOINING_BATTLE:  'JOINING_BATTLE',  // Joining a monster fight
  ATTACKING:       'ATTACKING',       // Attack loop on a monster
  WAITING_LOOT:    'WAITING_LOOT',    // Monster dead, waiting to loot
  LOOTING:         'LOOTING',         // Claiming loot from dead monster
  HEALING:         'HEALING',         // Using heal or potion
  FARMING_ENERGY:  'FARMING_ENERGY',  // Chapter reaction farming for stamina
  CHALLENGE_WAIT:  'CHALLENGE_WAIT',  // Cloudflare/captcha — human needed
  PAUSED:          'PAUSED',          // User paused the bot
};

const RUNNING_STATES = new Set([
  BotState.IDLE,
  BotState.SCANNING_GATES,
  BotState.JOINING_BATTLE,
  BotState.ATTACKING,
  BotState.WAITING_LOOT,
  BotState.LOOTING,
  BotState.HEALING,
  BotState.FARMING_ENERGY,
]);

const ALLOWED_TRANSITIONS = {
  [BotState.STOPPED]: new Set([BotState.IDLE]),
  [BotState.IDLE]: new Set([
    BotState.SCANNING_GATES,
    BotState.JOINING_BATTLE,
    BotState.ATTACKING,
    BotState.WAITING_LOOT,
    BotState.LOOTING,
    BotState.HEALING,
    BotState.FARMING_ENERGY,
  ]),
  [BotState.SCANNING_GATES]: new Set([
    BotState.IDLE,
    BotState.JOINING_BATTLE,
    BotState.ATTACKING,
    BotState.FARMING_ENERGY,
  ]),
  [BotState.JOINING_BATTLE]: new Set([
    BotState.IDLE,
    BotState.ATTACKING,
    BotState.SCANNING_GATES,
  ]),
  [BotState.ATTACKING]: new Set([
    BotState.IDLE,
    BotState.HEALING,
    BotState.WAITING_LOOT,
    BotState.FARMING_ENERGY,
    BotState.SCANNING_GATES,
  ]),
  [BotState.WAITING_LOOT]: new Set([
    BotState.IDLE,
    BotState.LOOTING,
    BotState.SCANNING_GATES,
  ]),
  [BotState.LOOTING]: new Set([
    BotState.IDLE,
    BotState.SCANNING_GATES,
  ]),
  [BotState.HEALING]: new Set([
    BotState.IDLE,
    BotState.ATTACKING,
    BotState.SCANNING_GATES,
    BotState.FARMING_ENERGY,
  ]),
  [BotState.FARMING_ENERGY]: new Set([
    BotState.IDLE,
    BotState.SCANNING_GATES,
    BotState.ATTACKING,
  ]),
  [BotState.CHALLENGE_WAIT]: new Set([
    BotState.IDLE,
    BotState.PAUSED,
  ]),
  [BotState.PAUSED]: new Set([
    BotState.IDLE,
    BotState.CHALLENGE_WAIT,
  ]),
};

class BotFSM {
  constructor(initialState = BotState.STOPPED) {
    this.currentState = initialState;
    this.previousState = null;
    this.listeners = [];
  }

  /**
   * Subscribe to state transition events
   * @param {Function} callback (newState, oldState) => void
   * @returns {Function} unsubscribe function
   */
  onTransition(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * Transition to a new state if valid
   * @param {string} newState
   * @param {string} [reason='']
   */
  transition(newState, reason = '') {
    if (!Object.values(BotState).includes(newState)) {
      throw new Error(`Invalid bot state: ${newState}`);
    }

    if (this.currentState === newState) {
      return;
    }

    if (newState !== BotState.STOPPED &&
        newState !== BotState.PAUSED &&
        newState !== BotState.CHALLENGE_WAIT &&
        !ALLOWED_TRANSITIONS[this.currentState]?.has(newState)) {
      throw new Error(`Invalid bot transition: ${this.currentState} -> ${newState}`);
    }

    const oldState = this.currentState;
    this.previousState = oldState;
    this.currentState = newState;

    for (const listener of this.listeners) {
      try {
        listener(newState, oldState, reason);
      } catch (err) {
        console.error('Error in FSM listener:', err);
      }
    }
  }

  get state() {
    return this.currentState;
  }

  get prevState() {
    return this.previousState;
  }

  is(state) {
    return this.currentState === state;
  }
}

module.exports = { BotFSM, BotState, RUNNING_STATES, ALLOWED_TRANSITIONS };
