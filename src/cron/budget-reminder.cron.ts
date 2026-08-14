import cron from "node-cron";
import { processBudgetReminderService } from "../services/budget-reminder.service";

export const startBudgetReminderCron = () => {
  // AfterNoon 12:30 PM
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
