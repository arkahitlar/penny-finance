import { OpenAIParser } from '../ai/OpenAIParser.js';
import { getDatabaseClient } from '../db/client.js';
import { ExpenseRepository } from '../db/ExpenseRepository.js';
import { ExpenseService } from './ExpenseService.js';

let service;

export function getExpenseService() {
  if (!service) {
    service = new ExpenseService({ repository: new ExpenseRepository(getDatabaseClient()), parser: new OpenAIParser() });
  }
  return service;
}
