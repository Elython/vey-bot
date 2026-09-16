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
      this.current = null;
      document.getElementById('btnCloseMonsterStats')?.addEventListener('click', () => this.close());
      this.modal?.addEventListener('click', event => {
        if (event.target === this.modal) this.close();
      });
      this.refreshButton?.addEventListener('click', () => this.load(true));
    }

    open(areaKey, monsterKey, name) {
      this.current = { areaKey, monsterKey, name };
      if (this.title) this.title.textContent = `${name} Stats`;
      if (this.modal) this.modal.style.display = 'flex';
      this.load(false);
    }

    close() {
      if (this.modal) this.modal.style.display = 'none';
    }

    async load(refresh) {
      if (!this.current || !this.content) return;
      this.content.replaceChildren(this._message('Loading monster stats…'));
      if (this.status) this.status.textContent = refresh ? 'Refreshing from battle page…' : '';
      this.status?.classList.remove('has-conflict');
      if (this.refreshButton) this.refreshButton.disabled = true;
      try {
        const result = await this.api.getMonsterStats(
          this.current.areaKey,
          this.current.monsterKey,
          refresh
        );
        if (!result?.success) throw new Error(result?.error || 'Monster Stats are unavailable');
        this.render(result.record, result);
      } catch (error) {
        this.content.replaceChildren(this._message(error.message, 'monster-stats-error'));
        if (this.status) this.status.textContent = 'No verified stats available';
      } finally {
        if (this.refreshButton) this.refreshButton.disabled = false;
      }
    }

    render(record, result) {
      const stats = record?.stats || {};
      const cells = [
        ['EXP / DMG', Number.isFinite(Number(stats.expPerDamage)) ? Number(stats.expPerDamage).toFixed(6) : 'Unknown'],
        ['Attack', formatNumber(stats.attack)],
        ['Defense', formatNumber(stats.defense)],
        ['Pet Defense', formatNumber(stats.petDefense)],
        ['Equipment Defense', formatNumber(stats.equipmentDefense)],
        ['Element', stats.element || 'Unknown'],
        ['Element Rate', `${formatNumber(stats.elementRatePercent)}%`],
        ['Rewards Up To', stats.rewardsUpToLevel == null ? 'Unknown' : `LV ${formatNumber(stats.rewardsUpToLevel)}`],
        ['Crit Rate Resistance', `${formatNumber(stats.resistances?.critRatePercent)}%`],
        ['Crit Damage Resistance', `${formatNumber(stats.resistances?.critDamagePercent)}%`],
        ['Final Damage Resistance', `${formatNumber(stats.resistances?.finalDamagePercent)}%`],
        ['Passive Damage Resistance', `${formatNumber(stats.resistances?.passiveDamagePercent)}%`],
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
      const observed = record?.provenance?.observedAt;
      const source = result.cached ? 'Saved verified catalog' : 'Live battle page';
      if (this.status) {
        this.status.textContent = result.conflict
          ? `${source} · conflicting live values detected; verified values were preserved`
          : `${source}${observed ? ` · observed ${observed}` : ''}`;
        this.status.classList.toggle('has-conflict', Boolean(result.conflict));
      }
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
