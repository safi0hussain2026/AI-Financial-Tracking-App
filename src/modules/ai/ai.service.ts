import redis from "../../config/redis";
import { AIMessageRole } from "../../generated/prisma/enums";
import { aiAnalyzedSummary } from "../../prompts/ai-analyzed-summary.prompt";
import { buildAIChatPrompt } from "../../utils/aiChatPrompt";
import { buildAIFinancialContext } from "../../utils/aiFinancialContext";
import { cleanAIResponse } from "../../utils/cleanAIResponse";
import { calculateFinancialHealthScore } from "../../utils/financialHealthScore";
import { generateAIResponse } from "../../utils/generateAIResponse";
import { getCurrentPeriod } from "../../utils/getCurrentPeriod";
import { parseAIJson } from "../../utils/parseAIJson";
import { BudgetRepository } from "../budget/budget.repository";
import { getExpenseSummaryAnalyticsService } from "../expense/expense.service";
import { getIncomeAnalyticsService } from "../income/income.service";
import { RecurringExpenseRepository } from "../recurringExpense/recurringExpense.repository";
import { AIInsightRepository } from "./ai.repository";
import {
  AIChatFinancialContext,
  AIChatInput,
  FinancialHealthInput,
} from "./ai.types";

const aiInsightRepository = new AIInsightRepository();
const budgetRepository = new BudgetRepository();
const recurringExpenseRepository = new RecurringExpenseRepository();

export const analyzeSpending = async (userId: string) => {
  const [expenseAnalytics, incomeAnalytics] = await Promise.all([
    getExpenseSummaryAnalyticsService(userId),
    getIncomeAnalyticsService(userId),
  ]);
  const financialContext = buildAIFinancialContext(
    expenseAnalytics,
    incomeAnalytics,
  );
  const prompt = aiAnalyzedSummary(financialContext);

  const aiResponse = await generateAIResponse(prompt);

  const parsedResponse = parseAIJson(aiResponse);

  return parsedResponse;
};

export const getFinancialHealth = async (userId: string) => {
  const financialData = await getFinancialHealthData(userId);
  const financialHealth = calculateFinancialHealthScore(
    financialData as FinancialHealthInput,
  );

  return financialHealth;
};

export const getFinancialHealthData = async (
  userId: string,
): Promise<FinancialHealthInput> => {
  const [
    expenseAnalytics,
    incomeAnalytics,
    budgetPercentage,
    recurringExpenses,
  ] = await Promise.all([
    getExpenseSummaryAnalyticsService(userId),
    getIncomeAnalyticsService(userId),
    budgetRepository.currentMonthBudgetUsage(userId),
    recurringExpenseRepository.getRecurringExpenseMonthlyTotal(userId),
  ]);
  const { summary } = expenseAnalytics;
  const { MonthlyIncome } = incomeAnalytics;
  const { monthlyExpense } = summary;
  const budgetUsagePercentage = budgetPercentage.usagePercentage;

  return {
    monthlyIncome: MonthlyIncome,
    monthlyExpenses: monthlyExpense,
    budgetUsagePercentage,
    incomeSourceCount: incomeAnalytics.incomeBySource.length,
    recurringExpenses,
  };
};

export const getSpendingAnalysis = async (userId: string) => {
  const period = getCurrentPeriod();
  const cacheKey = `ai:spending-analysis:${userId}:${period}`;
  const cacheData = await redis.get(cacheKey);
  if (cacheData) {
    return { source: "CACHE", data: JSON.parse(cacheData) };
  }
  const existingInsight = await aiInsightRepository.findByUserAndPeriod(
    userId,
    period,
  );
  if (
    existingInsight &&
    existingInsight.expiresAt &&
    existingInsight.expiresAt > new Date()
  ) {
    await redis.set(
      cacheKey,
      JSON.stringify(existingInsight.result),
      "EX",
      60 * 60 * 24,
    );
    return { source: "DATABASE", data: existingInsight.result };
  } else {
    const aiResult = await analyzeSpending(userId);

    await aiInsightRepository.create({
      userId,
      period,
      result: aiResult,
      model: "gemini",
      expiresAt: new Date(Date.now() + 60 * 60 * 24 * 1000),
    });
    await redis.set(cacheKey, JSON.stringify(aiResult), "EX", 60 * 60 * 24);
    return {
      source: "AI",
      data: aiResult,
    };
  }
};

export const invalidateSpendingAnalysisCache = async (userId: string) => {
  const period = getCurrentPeriod();

  const key = `ai:spending-analysis:${userId}:${period}`;

  await redis.del(key);
};

export const refreshSpendingAnalysis = async (userId: string) => {
  const period = getCurrentPeriod();
  const cacheKey = `ai:spending-analysis:${userId}${period}`;
  const aiResult = await analyzeSpending(userId);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  console.log("aiResult", aiResult);

  const existingAIInsight = await aiInsightRepository.findByUserAndPeriod(
    userId,
    period,
  );
  if (existingAIInsight) {
    await aiInsightRepository.updateAIInsights(existingAIInsight.id, {
      result: aiResult,
      model: "gemini",
      expiresAt,
    });
  } else {
    await aiInsightRepository.create({
      userId,
      period,
      result: aiResult,
      model: "gemini",
      expiresAt,
    });
  }
  await redis.set(cacheKey, JSON.stringify(aiResult), "EX", 60 * 60 * 24);
  return {
    data: aiResult,
    source: "AI_REFRESH",
  };
};

export const getAIChatFinancialContext = async (
  userId: string,
): Promise<AIChatFinancialContext> => {
  const [expenseAnalytics, incomeAnalytics, budgetData, recurringData] =
    await Promise.all([
      getExpenseSummaryAnalyticsService(userId),
      getIncomeAnalyticsService(userId),
      budgetRepository.currentMonthBudgetUsage(userId),
      recurringExpenseRepository.getRecurringExpenseMonthlyTotal(userId),
    ]);

  const monthlyIncome = Number(incomeAnalytics.MonthlyIncome) || 0;

  const monthlyExpenses = Number(expenseAnalytics.summary.monthlyExpense) || 0;

  const monthlySavings = monthlyIncome - monthlyExpenses;

  const savingsRate =
    monthlyIncome > 0
      ? Number(((monthlySavings / monthlyIncome) * 100).toFixed(2))
      : 0;

  return {
    income: {
      monthly: monthlyIncome,

      sources:
        incomeAnalytics.incomeBySource?.map((item: any) => ({
          source: item.source,
          amount: Number(item.amount),
          percentage: Number(item.percentage),
        })) || [],
    },

    expenses: {
      monthly: monthlyExpenses,

      categories:
        expenseAnalytics.categoryBreakdown?.map((item: any) => ({
          name: item.name,
          amount: Number(item.amount),
          percentage: Number(item.percentage),
        })) || [],

      highestExpense: expenseAnalytics.highestExpense
        ? {
            amount: Number(expenseAnalytics.highestExpense.amount),
            description: expenseAnalytics.highestExpense.description,
            category: expenseAnalytics.highestExpense.category,
          }
        : null,
    },

    savings: {
      monthly: monthlySavings,
      rate: savingsRate,
    },

    budget: {
      totalBudget: budgetData.totalBudget,
      totalUsed: budgetData.totalUsed,
      usagePercentage: budgetData.usagePercentage,
    },

    recurring: {
      monthly: recurringData,
    },
  };
};

export const chatWithAI = async (userId: string, data: AIChatInput) => {
  const { history, message } = data;
  const financialContext = await getAIChatFinancialContext(userId);
  const prompt = buildAIChatPrompt(financialContext, history || [], message);
  const aiResponse = generateAIResponse(prompt);
  const parsedResponse = cleanAIResponse(await aiResponse);
  return {
    response: parsedResponse,
    role: AIMessageRole.ASSISTANT,
  };
};
