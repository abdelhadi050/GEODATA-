/**
 * GEODATA HUB — authentication (NextAuth v4) + DB-fresh authorization.
 *
 * Identity is carried on the JWT (id, email, name). Role and isActive are
 * NEVER trusted from the token for authorization — getSessionUser() re-reads
 * them from the database on every protected request, so deactivations and role
 * changes take effect immediately (security requirement §5).
 */
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 }, // 30 days
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        const user = await db.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            organizationId: true,
            passwordHash: true,
          },
        });
        if (!user || !user.isActive) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        // Safe fields only — passwordHash never returned.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;
        token.organizationId = (user as { organizationId?: string }).organizationId;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        // Display identity only. Authoritative role/isActive come from getSessionUser().
        session.user.id = (token.id as string) ?? session.user.id ?? "";
        session.user.role = (token.role as string) ?? "";
        session.user.organizationId = (token.organizationId as string) ?? "";
      }
      return session;
    },
  },
};

/**
 * The authoritative session for any protected server context.
 * Returns the DB-fresh user or null when unauthenticated / deactivated.
 */
export async function getSessionUser() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id;
  if (!id) return null;

  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      organizationId: true,
    },
  });
  if (!user || !user.isActive) return null;
  return user;
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

// --- Type augmentations for our custom session/JWT fields ---
declare module "next-auth" {
  interface User {
    role?: string;
    organizationId?: string;
  }
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: string;
      organizationId: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    organizationId?: string;
  }
}
