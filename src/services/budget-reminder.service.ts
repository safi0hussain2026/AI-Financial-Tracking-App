import { BudgetAlertType } from "../generated/prisma/enums";
import { getBudgetsNeedingReminderService } from "../modules/budget/budget.service";
import { BudgetAlertRepository } from "../modules/budgetAlert/budgetAlert.repository";
import { budgetAlertQueue } from "../queues/budget-alert.queue";
import { ensureBudgetAlertWorkerRunning } from "../workers/budget-alert.worker";

const budgetAlertRepository = new BudgetAlertRepository();

export const processBudgetReminderService = async () => {
  const needReminderBudgets = await getBudgetsNeedingReminderService();
  for (let needReminderBudget of needReminderBudgets) {
    const { budget, percentage } = needReminderBudget;
    let type = null;
    if (Number(percentage) >= 100) {
      type = BudgetAlertType.EXCEEDED;
    } else if (Number(percentage) >= 90) {
      type = BudgetAlertType.WARNING;
    } else {
      continue;
    }
    const existingAlert = await budgetAlertRepository.findAlert(
      budget.id,
      type,
    );
    let alert = null;
    if (existingAlert) {
      const canSendReminder = await budgetAlertRepository.canSendReminder(
        existingAlert.id,
      );
      if (!canSendReminder) continue;
      alert = await budgetAlertRepository.update(existingAlert.id, {
        lastReminderSentAt: new Date(),
      });
    } else {
      alert = await budgetAlertRepository.create({
        userId: budget.user.id,
        budgetId: budget.id,
        type,
        percentage: Number(percentage),
        message: `${budget.category.name} budget is ${type}.`,
        pushSentAt: new Date(),
        pushSent: false,
      });
    }
    await budgetAlertQueue.add(
      "budget-alert-job",
      {
        alertId: alert.id,
      },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    );
    ensureBudgetAlertWorkerRunning();
  }
};
