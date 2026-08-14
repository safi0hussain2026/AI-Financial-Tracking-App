import cron from "node-cron";
import { processBudgetReminderService } from "../services/budget-reminder.service";

export const startBudgetReminderCron = () => {
  // Morning 9 AM
  cron.schedule(
    "45 12 * * *",
    async () => {
      await processBudgetReminderService();
    },
    {
      timezone: "Asia/Karachi",
    },
  );

  // Night 11 PM
  cron.schedule(
    "0 23 * * *",
    async () => {
      await processBudgetReminderService();
    },
    {
      timezone: "Asia/Karachi",
    },
  );
};
