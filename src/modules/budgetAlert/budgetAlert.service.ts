import { BudgetAlertType } from "../../generated/prisma/enums";
import { budgetAlertQueue } from "../../queues/budget-alert.queue";
import { ensureBudgetAlertWorkerRunning } from "../../workers/budget-alert.worker";
import { BudgetAlertRepository } from "./budgetAlert.repository";

const budgetAlertRepository = new BudgetAlertRepository();

export const checkBudgetAlert = async (userId: string, categoryId: string) => {
  const budget = await budgetAlertRepository.findBudgetByCategoryAndUser(
    categoryId,
    userId,
  );
  if (!budget) {
    return;
  }
  const totalAmount = await budgetAlertRepository.getSpentAmount(
    userId,
    budget.month,
    budget.year,
    categoryId,
  );
  const percentage = Number(
    ((totalAmount / Number(budget.amount)) * 100).toFixed(2),
  );
  let type: BudgetAlertType | null = null;
  if (percentage >= 100) {
    type = "EXCEEDED";
  } else if (percentage >= 80) {
    type = "WARNING";
  }
  if (!type) return null;
  const existingAlert = await budgetAlertRepository.findRecentAlert(
    budget.id,
    type,
  );
  if (existingAlert) return existingAlert;
  const alert = await budgetAlertRepository.create({
    userId,
    budgetId: budget.id,
    type,
    percentage,
    message: `${budget.category.name} budget is ${type}.`,
    pushSent: false,
    pushSentAt: new Date(),
  });
  await budgetAlertQueue.add(
    "budget-alert-job",
    {
      alertId: alert.id,
    },
    { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
  );
  ensureBudgetAlertWorkerRunning();
  return alert;
};
