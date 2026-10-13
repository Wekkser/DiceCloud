import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { RateLimiterMixin } from 'ddp-rate-limiter-mixin';
import SimpleSchema from 'simpl-schema';
import EngineActions from '/imports/api/engine/action/EngineActions';
import { assertEditPermission } from '/imports/api/sharing/sharingPermissions';
import { getCreature } from '/imports/api/engine/loadCreatures';
import applyAction from '/imports/api/engine/action/functions/applyAction';
import writeActionResults from '/imports/api/engine/action/functions/writeActionResults';
import mutationToLogUpdates from '/imports/api/engine/action/functions/mutationToLogUpdates';
import getDeterministicDiceRoller from '/imports/api/engine/action/functions/userInput/getDeterministicDiceRoller';
import InputProvider, { Advantage } from '/imports/api/engine/action/functions/userInput/InputProvider';

/**
 * Master AI (branch master-ai): runs an action without a human answering the prompts.
 * Unlike actions.runAction, the caller doesn't need to know the order of the decisions:
 * - targets come from the task (set at insertAction);
 * - advantage, when given, overrides the suggested one (also for checks);
 * - branch choices are matched by child name or id, in order; otherwise the first child is taken;
 * - dice are rolled by the same deterministic roller as runAction.
 * Returns the log lines of the action, so the caller can narrate the outcome.
 */
export function getAutoInputProvider(
  actionId: string, { advantage, choices = [] }: { advantage?: Advantage, choices?: string[] }
): InputProvider {
  const rollDice = getDeterministicDiceRoller(actionId);
  const wanted = [...choices];
  return {
    targetIds(target, currentTargetIds = []) {
      return Promise.resolve(currentTargetIds);
    },
    rollDice,
    choose(options, quantity = [1, 1]) {
      const min = Math.max(1, quantity[0]);
      const picked: string[] = [];
      while (wanted.length && picked.length < (quantity[1] === -1 ? options.length : quantity[1])) {
        const want = String(wanted[0]).toLowerCase();
        const match = options.find(o => o._id === wanted[0] || String(o.name ?? '').toLowerCase() === want);
        if (!match) break;
        wanted.shift();
        picked.push(match._id);
      }
      for (const o of options) {
        if (picked.length >= min) break;
        if (!picked.includes(o._id)) picked.push(o._id);
      }
      return Promise.resolve(picked);
    },
    advantage(suggested) {
      return Promise.resolve(advantage ?? suggested);
    },
    check(suggested) {
      return Promise.resolve(advantage === undefined ? suggested : { ...suggested, advantage });
    },
  };
}

export const runAuto = new ValidatedMethod({
  name: 'actions.runAuto',
  validate: new SimpleSchema({
    actionId: String,
    advantage: {
      type: SimpleSchema.Integer,
      allowedValues: [-1, 0, 1],
      optional: true,
    },
    choices: {
      type: Array,
      optional: true,
    },
    'choices.$': String,
  }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: {
    numRequests: 30,
    timeInterval: 5000,
  },
  run: async function ({ actionId, advantage, choices }: {
    actionId: string, advantage?: Advantage, choices?: string[]
  }) {
    const action = await EngineActions.findOneAsync(actionId);
    if (!action) throw new Meteor.Error('not-found', 'Action not found');
    assertEditPermission(getCreature(action.creatureId), this.userId);

    await applyAction(action, getAutoInputProvider(actionId, { advantage, choices }));

    const log = action.results.flatMap(result => result.mutations.flatMap(mutationToLogUpdates))
      .filter(content => !content.silenced)
      .map(({ name, value, targetIds }) => ({ name, value, targetIds }));
    await writeActionResults(action);
    return log;
  },
});
