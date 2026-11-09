import { auth, signIn, signOut } from "../auth";
import { AnalyticsView } from "../components/analytics-view";
import { FiltersBar } from "../components/filters";
import { readDashboard } from "../lib/api";
import { authConfigured, type ConfiguredApp, configuredApps } from "../lib/config";
import { demoAnalytics, demoApp, demoEventNames } from "../lib/demo";
import { isDemo, parseFilters, type SearchParams, single } from "../lib/policy";

export const dynamic = "force-dynamic";

function Brand() {
	return (
		<a className="brand" href="/" aria-label="SubKit Analytics home">
			<span className="brand-mark" aria-hidden="true">
				<i />
				<i />
				<i />
			</span>
			<span>
				SubKit<span className="brand-sub">ANALYTICS</span>
			</span>
		</a>
	);
}

function AccessCard({ setup = false }: { setup?: boolean }) {
	return (
		<main className="access-page">
			<Brand />
			<section className="access-card">
				<div className="eyebrow">YOUR APPS. A CLEARER PICTURE.</div>
				<h1>{setup ? "Connect your dashboard." : "Make sense of every day."}</h1>
				<p>
					{setup
						? "Configure GitHub sign-in, the dashboard allowlist, and your app connections to start exploring usage."
						: "Sign in with an approved GitHub account to explore your applications."}
				</p>
				{setup ? (
					<p className="setup-note">
						Setup instructions are in <code>docs/DASHBOARD.md</code>. Local synthetic previews use{" "}
						<code>SUBKIT_DEMO=true</code> in development only.
					</p>
				) : (
					<form
						action={async () => {
							"use server";
							await signIn("github", { redirectTo: "/" });
						}}
					>
						<button className="primary-button" type="submit">
							Continue with GitHub <span aria-hidden="true">↗</span>
						</button>
					</form>
				)}
			</section>
			<span className="access-footer">Open source. Built for the apps you create.</span>
		</main>
	);
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
	const demo = isDemo(process.env);
	if (!demo) {
		if (!authConfigured()) return <AccessCard setup />;
		const session = await auth();
		if (!session?.principal) return <AccessCard />;
	}
	const params = await searchParams;
	const filters = parseFilters(params);
	let apps: ConfiguredApp[];
	try {
		apps = demo ? [{ ...demoApp, apiKey: "" }] : configuredApps();
	} catch {
		return <AccessCard setup />;
	}
	const selected = apps.find((app) => app.slug === single(params.app)) ?? apps[0];
	if (!selected) return <AccessCard setup />;
	let result: Awaited<ReturnType<typeof readDashboard>> | null;
	try {
		result = demo
			? { analytics: demoAnalytics(filters), eventNames: demoEventNames }
			: await readDashboard(selected, filters);
	} catch {
		result = null;
	}
	return (
		<div className="dashboard-shell">
			<a className="skip-link" href="#main">
				Skip to analytics
			</a>
			<aside className="sidebar">
				<Brand />
				<div className="sidebar-label">WORKSPACE</div>
				<nav aria-label="Dashboard sections">
					<a className="nav-current" href="#overview">
						<span aria-hidden="true">◫</span>Overview
					</a>
					<a href="#activity">
						<span aria-hidden="true">↗</span>Activity
					</a>
					<a href="#funnel">
						<span aria-hidden="true">▽</span>Funnels
					</a>
					<a href="#retention">
						<span aria-hidden="true">◉</span>Retention
					</a>
				</nav>
				<div className="sidebar-bottom">
					<span className="open-source-dot" />
					Open-source analytics
					<p>
						A little signal.
						<br />A lot of understanding.
					</p>
				</div>
			</aside>
			<main id="main" className="main-content">
				<header className="topbar">
					<span className="breadcrumb">
						Workspace <span>/</span> {selected.name}
					</span>
					{demo ? (
						<span className="demo-badge">SYNTHETIC DEMO</span>
					) : (
						<form
							action={async () => {
								"use server";
								await signOut({ redirectTo: "/" });
							}}
						>
							<button className="text-button" type="submit">
								Sign out ↗
							</button>
						</form>
					)}
				</header>
				<div className="page-content">
					<div className="page-heading">
						<div>
							<div className="eyebrow">THE BIG PICTURE</div>
							<h1>Good things start with a little insight.</h1>
							<p>See how people use your app, and what makes them come back.</p>
						</div>
						<span className={`environment-pill ${filters.environment}`}>
							<i />
							{filters.environment === "production" ? "Production" : "Development"}
						</span>
					</div>
					{demo && (
						<div className="demo-notice">
							<strong>You're exploring a demo.</strong> Every person and event here is fictional. No
							live app data is connected.
						</div>
					)}
					<FiltersBar
						apps={apps.map(({ name, slug }) => ({ name, slug }))}
						app={selected.slug}
						filters={filters}
						eventNames={result?.eventNames ?? []}
					/>
					{result ? (
						<AnalyticsView
							data={result.analytics}
							filters={filters}
							eventNames={result.eventNames}
						/>
					) : (
						<section className="panel service-error" role="alert">
							<span aria-hidden="true">◌</span>
							<h2>We couldn't load this view.</h2>
							<p>
								The analytics service may be unavailable, or this app connection needs attention.
								Your recorded events have not been changed.
							</p>
							<a
								className="primary-button"
								href={`/?${new URLSearchParams({ app: selected.slug, range: filters.range, environment: filters.environment })}`}
							>
								Try again
							</a>
						</section>
					)}
				</div>
			</main>
		</div>
	);
}
