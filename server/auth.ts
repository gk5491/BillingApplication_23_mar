import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "./db.js";
import { User, UserRole } from "../shared/schema.js";

const JWT_SECRET = process.env.JWT_SECRET || "billflow-secret-change-in-production";

export interface AuthUser {
  id: string;
  email: string;
  role?: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function signToken(payload: AuthUser): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, JWT_SECRET) as AuthUser;
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = verifyToken(token);
    const userResult = await db.query`SELECT * FROM users WHERE id = ${payload.id}`;
    const user = userResult.recordset[0] as User;
    if (!user || !user.is_active) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const roleResult = await db.query`SELECT * FROM user_roles WHERE user_id = ${user.id}`;
    const roleRow = roleResult.recordset[0] as UserRole;
    req.user = { id: user.id, email: user.email, role: roleRow?.role };
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

