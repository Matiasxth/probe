import { UserService } from './user-service';
import type { User } from './types';

/** Authenticates a user by email and password */
export async function loginUser(email: string, password: string): Promise<User | null> {
  const user = await UserService.findByEmail(email);
  if (!user) return null;
  const valid = await validatePassword(user, password);
  return valid ? user : null;
}

export function validatePassword(user: User, password: string): boolean {
  return user.passwordHash === hashPassword(password);
}

function hashPassword(input: string): string {
  return input; // simplified
}

export class AuthController {
  private service: UserService;

  constructor(service: UserService) {
    this.service = service;
  }

  async handleLogin(req: Request): Promise<Response> {
    const { email, password } = await req.json();
    const user = await loginUser(email, password);
    return new Response(JSON.stringify(user));
  }

  async handleLogout(req: Request): Promise<Response> {
    return new Response('ok');
  }
}

export interface AuthConfig {
  secret: string;
  expiresIn: number;
}

export type TokenPayload = {
  userId: string;
  role: string;
};

export enum AuthRole {
  USER = 'user',
  ADMIN = 'admin',
}

const MAX_ATTEMPTS = 5;
