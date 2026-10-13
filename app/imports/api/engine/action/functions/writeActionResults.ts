import EngineActions, { EngineAction } from '/imports/api/engine/action/EngineActions';
import mutationToPropUpdates from './mutationToPropUpdates';
import mutationToLogUpdates from '/imports/api/engine/action/functions/mutationToLogUpdates';
import { union, uniq } from 'lodash';
import CreatureLogs from '/imports/api/creature/log/CreatureLogs';
import bulkWrite from '/imports/api/engine/shared/bulkWrite';
import CreatureProperties from '/imports/api/creature/creatureProperties/CreatureProperties';
import computeCreature from '/imports/api/engine/computeCreature';

// master-ai: delay of the second compute after an action (see below)
const DEFERRED_COMPUTE_MS = 300;

export default async function writeActionResults(action: EngineAction) {
  if (!action._id) throw new Meteor.Error('type-error', 'Action does not have an _id');
  const engineActionPromise = EngineActions.removeAsync(action._id);
  const creaturePropUpdates: any[] = [];
  const logContents: any[] = [];

  // Collect all the updates and log content
  action.results.forEach(result => {
    result.mutations.forEach(mutation => {
      creaturePropUpdates.push(...mutationToPropUpdates(mutation));
      logContents.push(...mutationToLogUpdates(mutation));
    });
  });
  const allTargetIds: string[] = union(...logContents.map(c => c.targetIds));

  // Write the log
  const logPromise = CreatureLogs.insertAsync({
    content: logContents,
    creatureId: action.creatureId,
    tabletopId: action.tabletopId,
    actionId: action._id,
  });

  // Write the bulk updates, force them to sequential mode means we immediately get the results
  // in the subscription, rather than waiting for oplog tailing to catch up
  const bulkWritePromise = bulkWrite(creaturePropUpdates, CreatureProperties, true);

  await Promise.all([engineActionPromise, logPromise, bulkWritePromise]);

  // Recompute the creatures involved
  const creatureIds = uniq([action.creatureId, ...allTargetIds]);
  const recomputePromises = creatureIds.map(creatureId => computeCreature(creatureId));

  const results = await Promise.all(recomputePromises);

  // master-ai: the compute above reads the in-memory creature (when it is loaded by a subscription), which
  // the observers may not have updated with the writes above yet: e.g. the ruleset toggle `hitPoints = 0`
  // stayed off after the damage that brought a character to 0 HP, until the next action. A second,
  // deferred compute sees the written values, from memory or from the database if the creature was unloaded.
  Meteor.setTimeout(() => {
    for (const creatureId of creatureIds) computeCreature(creatureId).catch(e => console.error('deferred compute', creatureId, e));
  }, DEFERRED_COMPUTE_MS);

  return results;
}
