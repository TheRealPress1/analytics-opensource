import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { githubPrincipal } from "./lib/github";
import { allowlist, isAllowed } from "./lib/policy";

declare module "next-auth" {
	interface Session {
		principal?: { githubId?: string; verifiedEmail?: string };
	}
	interface User {
		githubId?: string;
		verifiedEmail?: string;
	}
}

export const { handlers, auth, signIn, signOut } = NextAuth({
	providers: [GitHub({ authorization: { params: { scope: "read:user user:email" } } })],
	session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
	callbacks: {
		async signIn({ account, profile, user }) {
			if (account?.provider !== "github" || !profile?.id) return false;
			const principal = await githubPrincipal(
				String(profile.id),
				account.access_token,
				allowlist(process.env),
			);
			if (!principal) return false;
			user.githubId = principal.githubId;
			user.verifiedEmail = principal.verifiedEmail;
			return true;
		},
		jwt({ token, user }) {
			if (user) {
				token.githubId = user.githubId;
				token.verifiedEmail = user.verifiedEmail;
			}
			return token;
		},
		session({ session, token }) {
			const principal = {
				githubId: typeof token.githubId === "string" ? token.githubId : undefined,
				verifiedEmail: typeof token.verifiedEmail === "string" ? token.verifiedEmail : undefined,
			};
			if (isAllowed(principal, allowlist(process.env))) session.principal = principal;
			return session;
		},
	},
});
