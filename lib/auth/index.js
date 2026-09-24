import { getDatabaseClient } from '../db/client.js';
import { AuthRepository } from './AuthRepository.js';
import { AuthService } from './AuthService.js';
import { GoogleProvider } from './GoogleProvider.js';
import { checkSameOrigin, readAppOrigin, readAuthConfig } from './config.js';

let service;

export function getAuthService() {
  if (!service) {
    const config = readAuthConfig();
    service = new AuthService({
      config,
      repository: () => new AuthRepository(getDatabaseClient()),
      provider: config ? new GoogleProvider(config) : null,
    });
  }
  return service;
}

export const requireUser = (req) => getAuthService().requireUser(req);
export const requireSameOrigin = (req) => checkSameOrigin(req, readAppOrigin());
