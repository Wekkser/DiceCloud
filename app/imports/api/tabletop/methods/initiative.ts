import SimpleSchema from 'simpl-schema';
import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { RateLimiterMixin } from 'ddp-rate-limiter-mixin';
import { Random } from 'meteor/random';
import Tabletops from '/imports/api/tabletop/Tabletops';
import Creatures from '/imports/api/creature/creatures/Creatures';
import CreatureVariables from '/imports/api/creature/creatures/CreatureVariables';
import CreatureProperties from '/imports/api/creature/creatureProperties/CreatureProperties';

/**
 * Master AI (branch master-ai): initiative and turns on a tabletop.
 * The schema already had tabletop.initiative and creature.initiativeRoll, but nothing drove them.
 *
 * Turn order: initiativeRoll descending, then initiative bonus, then name.
 * Only the owner or a game master of the tabletop can run combat.
 */

type Combatant = { _id: string, name: string, initiativeRoll?: number, bonus: number };

function assertCanRunCombat(tabletopId: string, userId: string | null) {
  if (!userId) throw new Meteor.Error('logged-out', 'You need to be logged in');
  const tabletop = Tabletops.findOne(tabletopId);
  if (!tabletop) throw new Meteor.Error('not-found', 'Tabletop not found');
  if (tabletop.owner !== userId && !tabletop.gameMasters.includes(userId)) {
    throw new Meteor.Error('not-game-master', 'Only the owner or a game master can run combat');
  }
  return tabletop;
}

function numberFromVariable(creatureId: string, scope: any, name: string, field: 'value' | 'modifier') {
  let variable = scope?.[name];
  if (variable?._propId) variable = CreatureProperties.findOne(variable._propId.split('_')[0]);
  const n = variable?.[field];
  return typeof n === 'number' && isFinite(n) ? n : undefined;
}

/** Initiative bonus: the `initiative` variable if the sheet has one, else the dexterity modifier. */
export function initiativeBonus(creatureId: string) {
  const scope = CreatureVariables.findOne({ _creatureId: creatureId });
  return numberFromVariable(creatureId, scope, 'initiative', 'value')
    ?? numberFromVariable(creatureId, scope, 'dexterity', 'modifier')
    ?? 0;
}

export function combatOrder(tabletopId: string): Combatant[] {
  return Creatures.find({ tabletopId }, { fields: { name: 1, initiativeRoll: 1 } }).fetch()
    .map(c => ({ _id: c._id, name: c.name, initiativeRoll: c.initiativeRoll, bonus: initiativeBonus(c._id) }))
    .sort((a, b) => (b.initiativeRoll ?? -Infinity) - (a.initiativeRoll ?? -Infinity)
      || b.bonus - a.bonus
      || String(a.name).localeCompare(String(b.name)));
}

const rollsSchema = {
  rolls: {
    type: Array,
    optional: true,
  },
  'rolls.$': Object,
  'rolls.$.creatureId': String,
  // Total already including the bonus, e.g. a player rolling at the table
  'rolls.$.total': SimpleSchema.Integer,
};

/** Rolls initiative (d20 + bonus) for the given creatures, or uses the totals provided. */
function rollInitiativeWork(tabletopId: string, creatureIds: string[] | undefined, rolls: { creatureId: string, total: number }[] = []) {
  const given = new Map(rolls.map(r => [r.creatureId, r.total]));
  const filter: any = { tabletopId };
  if (creatureIds) filter._id = { $in: creatureIds };
  const results: { creatureId: string, name: string, total: number, d20?: number, bonus: number }[] = [];
  for (const creature of Creatures.find(filter, { fields: { name: 1 } }).fetch()) {
    const bonus = initiativeBonus(creature._id);
    let total = given.get(creature._id);
    let d20: number | undefined;
    if (total === undefined) {
      d20 = Math.floor(Random.fraction() * 20) + 1;
      total = d20 + bonus;
    }
    Creatures.update(creature._id, { $set: { initiativeRoll: total } });
    results.push({ creatureId: creature._id, name: creature.name, total, d20, bonus });
  }
  return results;
}

export const rollInitiative = new ValidatedMethod({
  name: 'tabletops.rollInitiative',
  validate: new SimpleSchema({
    tabletopId: String,
    creatureIds: { type: Array, optional: true },
    'creatureIds.$': String,
    ...rollsSchema,
  }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: { numRequests: 20, timeInterval: 5000 },
  run({ tabletopId, creatureIds, rolls }) {
    assertCanRunCombat(tabletopId, this.userId);
    return rollInitiativeWork(tabletopId, creatureIds, rolls);
  },
});

export const startCombat = new ValidatedMethod({
  name: 'tabletops.startCombat',
  validate: new SimpleSchema({
    tabletopId: String,
    ...rollsSchema,
  }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: { numRequests: 10, timeInterval: 5000 },
  run({ tabletopId, rolls }) {
    assertCanRunCombat(tabletopId, this.userId);
    rollInitiativeWork(tabletopId, undefined, rolls);
    const order = combatOrder(tabletopId);
    if (!order.length) throw new Meteor.Error('empty-tabletop', 'No creatures in the tabletop');
    Tabletops.update(tabletopId, {
      $set: {
        'initiative.active': true,
        'initiative.roundNumber': 1,
        'initiative.activeCreature': order[0]._id,
        'initiative.initiativeNumber': order[0].initiativeRoll,
      },
    });
    return { round: 1, active: order[0]._id, order };
  },
});

export const nextTurn = new ValidatedMethod({
  name: 'tabletops.nextTurn',
  validate: new SimpleSchema({ tabletopId: String }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: { numRequests: 20, timeInterval: 5000 },
  run({ tabletopId }) {
    const tabletop = assertCanRunCombat(tabletopId, this.userId);
    if (!tabletop.initiative?.active) throw new Meteor.Error('no-combat', 'Combat has not started');
    // Creatures added mid-combat without a roll get one now, so they have a place in the order
    const unrolled = Creatures.find({ tabletopId, initiativeRoll: { $exists: false } }, { fields: { _id: 1 } })
      .map(c => c._id);
    if (unrolled.length) rollInitiativeWork(tabletopId, unrolled);
    const order = combatOrder(tabletopId);
    if (!order.length) throw new Meteor.Error('empty-tabletop', 'No creatures in the tabletop');

    let index = order.findIndex(c => c._id === tabletop.initiative.activeCreature);
    let round = tabletop.initiative.roundNumber || 1;
    if (index === -1) {
      // The active creature left the tabletop: continue from the next lower initiative
      const current = tabletop.initiative.initiativeNumber ?? Infinity;
      index = order.findIndex(c => (c.initiativeRoll ?? -Infinity) < current) - 1;
      if (index < -1) index = order.length - 1;
    }
    let next = index + 1;
    if (next >= order.length) {
      next = 0;
      round += 1;
    }
    Tabletops.update(tabletopId, {
      $set: {
        'initiative.roundNumber': round,
        'initiative.activeCreature': order[next]._id,
        'initiative.initiativeNumber': order[next].initiativeRoll,
      },
    });
    return { round, active: order[next]._id, order };
  },
});

export const endCombat = new ValidatedMethod({
  name: 'tabletops.endCombat',
  validate: new SimpleSchema({ tabletopId: String }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: { numRequests: 10, timeInterval: 5000 },
  run({ tabletopId }) {
    assertCanRunCombat(tabletopId, this.userId);
    Tabletops.update(tabletopId, {
      $set: { 'initiative.active': false, 'initiative.roundNumber': 0 },
      $unset: { 'initiative.activeCreature': 1, 'initiative.initiativeNumber': 1 },
    });
    Creatures.update({ tabletopId }, { $unset: { initiativeRoll: 1 } }, { multi: true });
  },
});
