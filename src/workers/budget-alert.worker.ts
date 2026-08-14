import { Worker } from "bullmq";
import "dotenv/config";

import redis from "../config/redis";
import { BudgetAlertRepository } from "../modules/budgetAlert/budgetAlert.repository";
import { EmailService } from "../services/email.service";
import { PushNotificationService } from "../services/push-notification.service";
import { budgetAlertTemplate } from "../templates/budgetAlertTemplate";
import { NotificationRepository } from "../modules/notification/notification.repository";
import { NotificationType } from "../generated/prisma/enums";

const budgetAlertRepository = new BudgetAlertRepository();
const emailService = new EmailService();
const pushNotificationService = new PushNotificationService();
const notificationRepository = new NotificationRepository();

// ------------------------------------
// Send Budget Alert Email
// ------------------------------------

const sendBudgetAlertEmail = async (alert: any) => {
  if (alert.emailSent) {
    return;
  }

  const html = budgetAlertTemplate({
    categoryName: alert.budget.category.name,
    amount: Number(alert.budget.amount),
    percentage: Number(alert.percentage),
    type: alert.type,
  });

  await emailService.sendEmail(
    alert.user.email,
    `Budget Alert for ${alert.budget.category.name}`,
    html,
  );

  await budgetAlertRepository.markEmailSent(alert.id);

  console.log(`Budget alert email sent: ${alert.id}`);
};

// ------------------------------------
// Send Budget Alert Push Notification
// ------------------------------------

const sendBudgetAlertPushNotification = async (alert: any) => {
  if (alert.pushSent || !alert.user.fcmToken) {
    return;
  }

  const categoryName = alert.budget.category.name;
  const amount = Number(alert.budget.amount).toLocaleString();
  const percentage = Number(alert.percentage);
  const budgetType = alert.type;
  const body = `${categoryName}: ${budgetType} — Rs. ${amount} (${percentage}%)`;
  let notificationPayload = {
    userId: alert.userId,
    title: "Budget Alert",
    message: body,
    type: NotificationType.BUDGET_ALERT,
    budgetType,
  };
  await notificationRepository.create(notificationPayload);
  await pushNotificationService.sendToToken(
    alert.user.fcmToken,
    "Budget Alert",
    body,
  );

  await budgetAlertRepository.markPushSent(alert.id);
};

// ------------------------------------
// Budget Alert Job Processor
// (extracted so it's reused by the on-demand worker below)
// ------------------------------------

const processBudgetAlertJob = async (job: any) => {
  if (job.name !== "budget-alert-job") {
    return;
  }

  const { alertId } = job.data;

  const alert = await budgetAlertRepository.findById(alertId);

  if (!alert) {
    return;
  }

  // Send Push Notification
  await sendBudgetAlertPushNotification(alert);

  // Send Email
  await sendBudgetAlertEmail(alert);
};

// ------------------------------------
// On-Demand Budget Alert Worker
//
// Instead of running 24/7 (which polls Redis constantly and burns
// through Upstash's request quota even when idle), this worker is
// created only when a job is added to the queue, and automatically
// closes itself after IDLE_TIMEOUT_MS of inactivity.
//
// Call `ensureBudgetAlertWorkerRunning()` immediately after every
// `budgetAlertQueue.add(...)` call, from anywhere in the app
// (cron job, expense-increase handler, etc).
// ------------------------------------

const IDLE_TIMEOUT_MS = 30_000; // close worker after 30s of no activity

let worker: Worker | null = null;
let idleTimer: NodeJS.Timeout | null = null;

const closeWorker = async () => {
  if (worker) {
    await worker.close();
    worker = null;
    console.log("Budget alert worker closed (idle)");
  }
};

const resetIdleTimer = () => {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(closeWorker, IDLE_TIMEOUT_MS);
};

export const ensureBudgetAlertWorkerRunning = () => {
  if (worker) {
    // Already running — just push the idle timer forward
    resetIdleTimer();
    return;
  }

  worker = new Worker("budget-alert-queue", processBudgetAlertJob, {
    connection: redis,
  });

  worker.on("completed", (job) => {
    console.log(`Budget alert job completed: ${job.id}`);
    resetIdleTimer();
  });

  worker.on("failed", (job, error) => {
    console.error(`Budget alert job failed: ${job?.id}`);
    console.error(error);
    resetIdleTimer();
  });

  console.log("Budget alert worker started");
  resetIdleTimer();
};

// ------------------------------------
// Graceful shutdown (optional but recommended)
// ------------------------------------

process.on("SIGTERM", async () => {
  if (idleTimer) clearTimeout(idleTimer);
  await closeWorker();
});
