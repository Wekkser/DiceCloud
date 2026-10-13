import TaskResult, { LogContent } from '../tasks/TaskResult';
import { EngineAction } from '/imports/api/engine/action/EngineActions';
import { applyDefaultAfterPropTasks } from '/imports/api/engine/action/functions/applyTaskGroups';
import recalculateInlineCalculations from '/imports/api/engine/action/functions/recalculateInlineCalculations';
import recalculateCalculation from '/imports/api/engine/action/functions/recalculateCalculation';
import { parse, prettifyParseError } from '/imports/parser/parser';
import { PropTask } from '/imports/api/engine/action/tasks/Task';
import getPropertyTitle from '/imports/api/utility/getPropertyTitle';

export default async function applyTriggerProperty(
  task: PropTask, action: EngineAction, result: TaskResult, userInput
): Promise<void> {
  const prop = task.prop;

  if (prop.type !== 'trigger') {
    throw new Meteor.Error('wrong-property', `Expected a trigger, got ${prop.type} instead`);
  }

  // master-ai: the trigger condition was never evaluated by the v3 engine, so every trigger fired whatever its
  // condition said (e.g. the ruleset's "Death Save Reset" ignored `!permanentDeathSaves`). Evaluate it now, with
  // the action scope, so it can use what the event put there (~damage, ~healing, ~set, ~criticalHit…).
  if (prop.condition?.calculation) {
    // Triggers inside an inactive toggle (e.g. "0 HP?") are not computed, so the condition may not be parsed yet
    if (!prop.condition.parseNode) {
      try {
        prop.condition.parseNode = parse(prop.condition.calculation);
      } catch (e) {
        result.appendLog({
          name: getPropertyTitle(prop),
          value: `Condition error: ${prettifyParseError(e as Error)}`,
          silenced: prop.silent,
        }, task.targetIds);
        return;
      }
    }
    await recalculateCalculation(prop.condition, action, 'reduce', userInput);
    if (!prop.condition.value) return;
  }

  const logContent: LogContent & { silenced: boolean | undefined } = {
    name: getPropertyTitle(prop),
    silenced: prop.silent,
  }

  // Add the trigger description to the log
  if (prop.description?.text) {
    await recalculateInlineCalculations(prop.description, action, 'reduce', userInput);
    if (prop.description.value) {
      logContent.value = prop.description.value;
    }
  }

  result.appendLog(logContent, task.targetIds);
  return applyDefaultAfterPropTasks(action, prop, task.targetIds, userInput);
}
