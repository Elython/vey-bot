const EventEmitter = require('events');

function createDefaultState(accountName = null) {
  return {
    accountName,
    stamina: { current: 0, max: 0, text: '- / -' },
    attack: 0,
    defense: 0,
    totalStamina: 0,
    level: 1,
    gold: '0',
    gems: '0',
    exp: '0',
    expCurrent: null,
    expRequired: null,
    expPercent: '0%',
    farmedEnergy: null,
    hourlyRefill: 40,
    twelveHourRefill: 40,
    nextStaminaIncrease: 40,
    hp: { current: 100, max: 100 },
    mp: { current: 50, max: 50 },
    serverEpoch: null,
    serverTzOff: 19800,
    lootXpBoost: { recognized: false, name: null, percent: 0, endsAt: null },
    username: null,
    lastUpdated: 0,
    isConnected: false,
  };
}

class StateStore extends EventEmitter {
  constructor() {
    super();
    this.state = createDefaultState();
  }

  setAccount(accountName) {
    this.state = createDefaultState(accountName);
    this.emit('change', this.state);
  }

  update(partialStats) {
    let changed = false;

    for (const [key, value] of Object.entries(partialStats)) {
      if (typeof value === 'object' && value !== null && this.state[key]) {
        // Shallow merge for nested objects like stamina, hp, mp
        for (const [subKey, subValue] of Object.entries(value)) {
          if (this.state[key][subKey] !== subValue) {
            this.state[key][subKey] = subValue;
            changed = true;
          }
        }
      } else {
        if (this.state[key] !== value) {
          this.state[key] = value;
          changed = true;
        }
      }
    }

    if (changed) {
      this.recalculateDerivedStats();
      this.state.lastUpdated = Date.now();
      this.emit('change', this.state);
    }
  }

  recalculateDerivedStats() {
    const { level, attack, defense, totalStamina, stamina, serverTzOff } = this.state;
    
    const baseHourly = 40 + (level / 50) + ((attack + defense) / 100);
    this.state.hourlyRefill = Math.floor(baseHourly);
    this.state.twelveHourRefill = Math.floor(baseHourly + (totalStamina / 2));

    const serverDate = new Date(Date.now() + ((serverTzOff ?? 19800) * 1000));
    const nextHour = (serverDate.getUTCHours() + 1) % 24;
    const isNext12h = (nextHour === 0 || nextHour === 12);
    
    this.state.nextStaminaIncrease = isNext12h ? this.state.twelveHourRefill : this.state.hourlyRefill;

    // ensure stamina text is updated
    if (stamina && stamina.current !== undefined && stamina.max !== undefined) {
      this.state.stamina.text = `${stamina.current} / ${stamina.max}`;
    }
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

// Export singleton instance
const stateStore = new StateStore();
module.exports = { stateStore, StateStore, createDefaultState };
