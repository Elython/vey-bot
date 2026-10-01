const NORMAL_ATTACKS = Object.freeze([
  Object.freeze({ multiplier: 1, id: 0, name: 'Slash x1', stamCost: 1 }),
  Object.freeze({ multiplier: 10, id: -1, name: 'Slash x10', stamCost: 10 }),
  Object.freeze({ multiplier: 50, id: -2, name: 'Slash x50', stamCost: 50 }),
  Object.freeze({ multiplier: 100, id: -3, name: 'Slash x100', stamCost: 100 }),
  Object.freeze({ multiplier: 200, id: -4, name: 'Slash x200', stamCost: 200 }),
  Object.freeze({ multiplier: 1000, id: -5, name: 'Slash x1000', stamCost: 1000 }),
]);

const NORMAL_ATTACK_BY_MULTIPLIER = new Map(NORMAL_ATTACKS.map(attack => [attack.multiplier, attack]));

function copyAttack(attack, planning) {
  return attack ? { ...attack, planning } : null;
}

function normalizeMultiplier(value, fallback = 1) {
  const requested = Number(value);
  return NORMAL_ATTACK_BY_MULTIPLIER.has(requested) ? requested : fallback;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function estimatedNormalAttack(attack, baseDamage, planning = {}) {
  return copyAttack(attack, {
    ...planning,
    estimatedDamage: Math.floor(baseDamage * attack.multiplier),
  });
}

class AttackPlanner {
  constructor(config = {}) {
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    this.config = config;
  }

  plan(state = {}) {
    const policy = this.config.combat?.attackStrategy || {};
    const mode = policy.mode === 'adaptive' ? 'adaptive' : 'fixed';
    const progression = state.progression || {};
    const reserve = progression.ignoreSoftStaminaRules === true
      ? 0
      : Math.max(0, Math.trunc(Number(this.config.combat?.staminaReserve) || 0));
    const budget = Math.max(0, Math.trunc(Number(state.stamina) || 0) - reserve);
    const maxMultiplier = normalizeMultiplier(policy.maxMultiplier, 200);
    const fixedMultiplier = normalizeMultiplier(policy.fixedMultiplier, 1);
    const configuredLimit = mode === 'fixed' ? fixedMultiplier : maxMultiplier;
    const affordable = NORMAL_ATTACKS.filter(attack => attack.multiplier <= configuredLimit && attack.stamCost <= budget);
    if (affordable.length === 0) return null;

    const preferredStaminaCost = Math.max(0, Math.trunc(Number(progression.preferredStaminaCost) || 0));
    const progressionAttack = affordable.find(attack => attack.stamCost === preferredStaminaCost);
    if (progressionAttack) {
      return copyAttack(progressionAttack, {
        mode,
        source: 'progression-level-alignment',
        estimatedDamage: null,
        remainingDamage: Number.isFinite(Number(state.remainingTargetDamage)) ? Number(state.remainingTargetDamage) : null,
      });
    }

    const baseDamage = positiveNumber(state.damageEstimate?.conservativeBaseDamage);
    const remainingDamage = Number(state.remainingTargetDamage);
    const selectedFixed = affordable.at(-1) || affordable[0];
    if (!baseDamage || !Number.isFinite(remainingDamage) || remainingDamage <= 0) {
      if (mode === 'fixed') {
        return copyAttack(selectedFixed, {
          mode,
          source: selectedFixed.multiplier === fixedMultiplier ? 'configured' : 'affordable-fallback',
          estimatedDamage: null,
          remainingDamage: Number.isFinite(remainingDamage) ? remainingDamage : null,
        });
      }
      return copyAttack(affordable[0], {
        mode,
        source: 'calibration',
        estimatedDamage: null,
        remainingDamage: Number.isFinite(remainingDamage) ? remainingDamage : null,
      });
    }

    if (mode === 'adaptive' && policy.requireTargetStamina === true && progression.ignoreSoftStaminaRules !== true) {
      const requiredStamina = Math.ceil(remainingDamage / baseDamage);
      if (budget < requiredStamina) {
        return {
          blocked: true,
          planning: {
            mode,
            source: 'insufficient-target-stamina',
            remainingDamage,
            requiredStamina,
            availableStamina: budget,
          },
        };
      }
    }

    const commonPlanning = {
      mode,
      remainingDamage,
      confidence: state.damageEstimate?.confidence || 'low',
      sampleCount: Number(state.damageEstimate?.sampleCount) || 0,
    };
    const abilities = this._abilityCandidates(state, { budget, baseDamage, commonPlanning });
    const monsterHp = positiveNumber(state.monsterHp ?? state.currentBattle?.monsterHp);
    if (mode === 'adaptive' && policy.nukeEnabled === true
      && monsterHp !== null && monsterHp < remainingDamage) {
      const normalCandidates = affordable.map(attack => estimatedNormalAttack(attack, baseDamage, {
        ...commonPlanning,
        source: 'nuke',
      }));
      const candidates = [
        ...normalCandidates,
        ...(policy.nukeAllowAbilities === true ? abilities.map(ability => ({
          ...ability,
          planning: { ...ability.planning, source: 'nuke-ability' },
        })) : []),
      ];
      const selectedMode = String(policy.nukeAttack || 'auto');
      const selected = selectedMode === 'auto'
        ? candidates
        : candidates.filter(candidate => selectedMode === (candidate.kind === 'class-ability'
          ? `ability:${candidate.id}`
          : `normal:${candidate.multiplier}`));
      const qualifying = selected
        .filter(candidate => candidate.planning.estimatedDamage >= remainingDamage)
        .sort((left, right) => left.planning.estimatedDamage - right.planning.estimatedDamage);
      if (qualifying.length > 0) {
        return {
          ...qualifying[0],
          planning: {
            ...qualifying[0].planning,
            source: qualifying[0].kind === 'class-ability' ? 'nuke-ability' : 'nuke',
            monsterHp,
            overkillRequired: true,
          },
        };
      }
      return {
        blocked: true,
        ignoreTarget: true,
        planning: {
          ...commonPlanning,
          source: 'nuke-unreachable',
          monsterHp,
          selectedNuke: selectedMode,
        },
      };
    }

    const targetDamage = Number(state.targetDamage);
    const failSafePercent = Math.min(100, Math.max(0, Number(policy.failSafePercent) || 0));
    const targetProgress = Number.isFinite(targetDamage) && targetDamage > 0
      ? ((targetDamage - remainingDamage) / targetDamage) * 100
      : null;
    if (policy.failSafeEnabled === true && targetProgress !== null && targetProgress >= failSafePercent) {
      return copyAttack(affordable[0], {
        mode,
        source: 'fail-safe',
        estimatedDamage: Math.floor(baseDamage),
        remainingDamage,
        targetProgress,
        confidence: state.damageEstimate?.confidence || 'low',
        sampleCount: Number(state.damageEstimate?.sampleCount) || 0,
      });
    }

    const overshootPercent = Math.min(500, Math.max(0, Number(policy.overshootPercent) || 0));
    const upperDamage = remainingDamage * (1 + (overshootPercent / 100));
    if (mode === 'fixed') {
      const normal = estimatedNormalAttack(selectedFixed, baseDamage, {
        ...commonPlanning,
        source: selectedFixed.multiplier === fixedMultiplier ? 'configured' : 'affordable-fallback',
      });
      // Fixed mode has no visible overshoot control. Keep class abilities at or
      // below the remaining target instead of applying a hidden Adaptive value.
      const fittingAbilities = abilities.filter(ability => ability.planning.estimatedDamage <= remainingDamage);
      const strongestAbility = fittingAbilities.sort((left, right) => left.planning.estimatedDamage - right.planning.estimatedDamage).at(-1);
      if (strongestAbility && (normal.planning.estimatedDamage > remainingDamage || strongestAbility.planning.estimatedDamage > normal.planning.estimatedDamage)) {
        return strongestAbility;
      }
      return normal;
    }

    const normalCandidates = affordable.map(attack => estimatedNormalAttack(attack, baseDamage, {
      ...commonPlanning,
      source: 'learned',
    }));
    const candidates = [...normalCandidates, ...abilities];
    const withinTarget = candidates
      .filter(candidate => candidate.planning.estimatedDamage <= upperDamage)
      .sort((left, right) => left.planning.estimatedDamage - right.planning.estimatedDamage);
    if (withinTarget.length > 0) return withinTarget.at(-1);
    return candidates.sort((left, right) => left.planning.estimatedDamage - right.planning.estimatedDamage)[0] || null;
  }

  _abilityCandidates(state, { budget, baseDamage, commonPlanning }) {
    const objectiveAbilityId = Math.max(0, Math.trunc(Number(state.objectiveAbilityId) || 0));
    if (this.config.combat?.allowAbilities !== true && objectiveAbilityId < 1) return [];
    const allowedIds = objectiveAbilityId > 0
      ? new Set([objectiveAbilityId])
      : new Set((this.config.combat?.allowedAbilityIds || []).map(Number));
    if (allowedIds.size === 0) return [];
    const currentMana = Math.max(0, Number(state.mana) || 0);
    const manaPolicy = this.config.resources?.mana || {};
    const manaReserve = Math.max(0, Number(manaPolicy.keepMin) || 0);

    return (Array.isArray(state.abilities) ? state.abilities : [])
      .filter(skill => {
        const role = objectiveAbilityId === Number(skill?.id)
          ? 'attack'
          : this.config.combat?.abilityPolicies?.[String(skill?.id)]?.role || (skill?.passive ? 'passive' : 'attack');
        return skill?.owned === true && skill.passive !== true && role === 'attack' && allowedIds.has(Number(skill.id));
      })
      .map(skill => {
        const stamCost = Math.max(0, Math.trunc(Number(skill.staminaCost) || 0));
        const manaCost = Math.max(0, Math.trunc(Number(skill.manaCost) || 0));
        const staminaUnits = Math.max(1, stamCost);
        const flatStaminaDamage = Math.max(0, Number(skill.flatStaminaDamage) || 0);
        if (stamCost > budget || currentMana - manaCost < manaReserve) return null;
        return {
          id: Number(skill.id),
          name: String(skill.name || `Ability ${skill.id}`),
          kind: 'class-ability',
          stamCost,
          requestStamCost: 1,
          manaCost,
          flatStaminaDamage,
          planning: {
            ...commonPlanning,
            source: 'class-ability',
            estimatedDamage: Math.floor((baseDamage + flatStaminaDamage) * staminaUnits),
            formula: '(x1 + flat stamina damage) × stamina cost',
          },
        };
      })
      .filter(Boolean);
  }
}

module.exports = {
  AttackPlanner,
  NORMAL_ATTACKS,
  normalizeMultiplier,
};
