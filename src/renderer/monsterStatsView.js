(() => {
  const formatNumber = value => Number.isFinite(Number(value))
    ? new Intl.NumberFormat().format(Number(value))
    : 'Unknown';

  class MonsterStatsView {
    constructor(api) {
      this.api = api;
      this.modal = document.getElementById('modalMonsterStats');
      this.title = document.getElementById('monsterStatsTitle');
      this.status = document.getElementById('monsterStatsStatus');
      this.content = document.getElementById('monsterStatsContent');
      this.refreshButton = document.getElementById('btnRefreshMonsterStats');
      this.applyButton = document.getElementById('btnApplyMonsterStats');
      this.current = null;
      document.getElementById('btnCloseMonsterStats')?.addEventListener('click', () => this.close());
      this.modal?.addEventListener('click', event => {
        if (event.target === this.modal) this.close();
      });
      this.refreshButton?.addEventListener('click', () => this.load(true));
      this.applyButton?.addEventListener('click', () => this.applyObserved());
    }

    open(areaKey, monsterKey, name) {
      this.current = { areaKey, monsterKey, name };
      if (this.title) this.title.textContent = uiText("{0} Stats", name);
      if (this.modal) this.modal.style.display = 'flex';
      this.load(false);
    }

    close() {
      if (this.modal) this.modal.style.display = 'none';
    }

    async load(refresh) {
      if (!this.current || !this.content) return;
      this.content.replaceChildren(this._message(uiText('Loading monster stats…')));
      if (this.status) this.status.textContent = refresh ? uiText('Refreshing from battle page…') : '';
      this.status?.classList.remove('has-conflict');
      if (this.applyButton) this.applyButton.style.display = 'none';
      if (this.refreshButton) this.refreshButton.disabled = true;
      try {
        const result = await this.api.getMonsterStats(
          this.current.areaKey,
          this.current.monsterKey,
          refresh
        );
        if (!result?.success) throw new Error(result?.error || uiText('Monster Stats are unavailable'));
        this.render(result.record, result);
      } catch (error) {
        this.content.replaceChildren(this._message(error.message, 'monster-stats-error'));
        if (this.status) this.status.textContent = uiText('No verified stats available');
      } finally {
        if (this.refreshButton) this.refreshButton.disabled = false;
      }
    }

    async applyObserved() {
      if (!this.current || !this.applyButton) return;
      this.applyButton.disabled = true;
      try {
        const result = await this.api.applyObservedMonsterStats(this.current.areaKey, this.current.monsterKey);
        if (!result?.success) throw new Error(result?.error || uiText('Changed Monster Stats could not be applied'));
        this.render(result.record, { conflict: false, applied: true });
      } catch (error) {
        if (this.status) {
          this.status.textContent = error.message;
          this.status.classList.add('has-conflict');
        }
      } finally {
        this.applyButton.disabled = false;
      }
    }

    render(record, result) {
      const stats = record?.stats || {};
      const cells = [
        [uiText('EXP / DMG'), Number.isFinite(Number(stats.expPerDamage)) ? Number(stats.expPerDamage).toFixed(6) : 'Unknown'],
        [uiText('Attack'), formatNumber(stats.attack)],
        [uiText('Defense'), formatNumber(stats.defense)],
        [uiText('Pet Defense'), formatNumber(stats.petDefense)],
        [uiText('Equipment Defense'), formatNumber(stats.equipmentDefense)],
        [uiText('Element'), stats.element || 'Unknown'],
        [uiText('Element Rate'), `${formatNumber(stats.elementRatePercent)}%`],
        [uiText('Rewards Up To'), stats.rewardsUpToLevel == null ? 'Unknown' : `LV ${formatNumber(stats.rewardsUpToLevel)}`],
        [uiText('Crit Rate Resistance'), `${formatNumber(stats.resistances?.critRatePercent)}%`],
        [uiText('Crit Damage Resistance'), `${formatNumber(stats.resistances?.critDamagePercent)}%`],
        [uiText('Final Damage Resistance'), `${formatNumber(stats.resistances?.finalDamagePercent)}%`],
        [uiText('Passive Damage Resistance'), `${formatNumber(stats.resistances?.passiveDamagePercent)}%`],
      ];
      const grid = document.createElement('div');
      grid.className = 'monster-stats-grid';
      for (const [label, value] of cells) {
        const cell = document.createElement('div');
        cell.className = 'monster-stats-cell';
        const labelElement = document.createElement('span');
        labelElement.textContent = label;
        const valueElement = document.createElement('strong');
        valueElement.textContent = value;
        cell.append(labelElement, valueElement);
        grid.appendChild(cell);
      }
      this.content.replaceChildren(grid);
      const rewards = Array.isArray(stats.possibleLoot) ? stats.possibleLoot : [];
      if (rewards.length > 0) {
        const groups = new Map();
        for (const reward of rewards) {
          const heading = reward.phase ? uiText("Phase {0} Loot", reward.phase) : uiText('Possible Loot');
          if (!groups.has(heading)) groups.set(heading, []);
          groups.get(heading).push(reward);
        }
        for (const [heading, items] of groups) {
          const section = document.createElement('section');
          section.className = 'monster-reward-section';
          const title = document.createElement('h4');
          title.textContent = heading;
          const list = document.createElement('div');
          list.className = 'monster-reward-list';
          for (const reward of items) {
            const row = document.createElement('div');
            row.className = 'monster-reward-row';
            const name = document.createElement('strong');
            name.textContent = reward.name;
            const detail = document.createElement('span');
            detail.textContent = uiText("{0} damage · {1}%", formatNumber(reward.damageRequired), formatNumber(reward.dropChance));
            row.append(name, detail);
            list.appendChild(row);
          }
          section.append(title, list);
          this.content.appendChild(section);
        }
      }
      const observed = record?.provenance?.observedAt;
      const source = result.cached ? uiText('Saved verified catalog') : uiText('Live battle page');
      if (this.status) {
        this.status.textContent = result.applied
          ? uiText('Changed live values were applied to the saved catalog')
          : result.conflict
          ? uiText("{0} · conflicting live values detected; verified values were preserved", source)
          : `${source}${observed ? ` · observed ${observed}` : ''}`;
        this.status.classList.toggle('has-conflict', Boolean(result.conflict));
      }
      if (this.applyButton) this.applyButton.style.display = result.conflict ? 'inline-flex' : 'none';
    }

    _message(text, className = '') {
      const message = document.createElement('div');
      message.className = `monster-stats-message ${className}`.trim();
      message.textContent = text;
      return message;
    }
  }

  window.MonsterStatsView = MonsterStatsView;
})();
