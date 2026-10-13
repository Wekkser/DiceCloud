import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { RateLimiterMixin } from 'ddp-rate-limiter-mixin';
import SimpleSchema from 'simpl-schema';
import { parse, prettifyParseError } from '/imports/parser/parser';
import resolve from '/imports/parser/resolve';
import toString from '/imports/parser/toString';
import toPrimitiveOrString from '/imports/parser/toPrimitiveOrString';
import rollDice from '/imports/parser/rollDice';
import Context from '/imports/parser/types/Context';
import InputProvider from '/imports/api/engine/action/functions/userInput/InputProvider';
import { getCreature, getVariables } from '/imports/api/engine/loadCreatures';
import { assertEditPermission } from '/imports/api/sharing/sharingPermissions';

/**
 * Master AI (branch master-ai): roll a free dice expression with DiceCloud's own parser and roller,
 * e.g. "2d6 + 3", "max(1d20, 1d20) + 2" (advantage) or, with a creature, "1d20 + dexterity.modifier".
 * The engine only rolls dice inside a creature's properties; this exposes the same parser for rolls
 * the game master asks for (random tables, checks without a sheet).
 */
export const rollExpression = new ValidatedMethod({
  name: 'dice.roll',
  validate: new SimpleSchema({
    expression: { type: String, max: 200 },
    creatureId: { type: String, max: 32, optional: true },
  }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: {
    numRequests: 30,
    timeInterval: 5000,
  },
  run: async function ({ expression, creatureId }: { expression: string, creatureId?: string }) {
    if (!this.userId) throw new Meteor.Error('logged-out', 'You need to be logged in');
    let scope = {};
    if (creatureId) {
      assertEditPermission(getCreature(creatureId), this.userId);
      scope = getVariables(creatureId) || {};
    }
    let node;
    try {
      node = parse(expression);
    } catch (e) {
      throw new Meteor.Error('parse-error', prettifyParseError(e as Error));
    }
    const input = {
      rollDice: (dice: { number: number, diceSize: number }[]) =>
        Promise.resolve(dice.map(d => rollDice(d.number, d.diceSize))),
    } as unknown as InputProvider;
    const context = new Context();
    const { result: compiled } = await resolve('compile', node, scope, context, input);
    const { result: rolled } = await resolve('roll', compiled, scope, context, input);
    const { result: reduced } = await resolve('reduce', rolled, scope, context, input);
    return {
      expression,
      rolled: toString(rolled),
      total: toPrimitiveOrString(reduced),
      errors: context.errors.map(e => e.message ?? String(e)),
    };
  },
});
