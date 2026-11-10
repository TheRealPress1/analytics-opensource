import type { Filters } from "../lib/policy";
import { percent } from "../lib/policy";
import type { Analytics } from "../lib/schema";
import { ActivityChart } from "./activity-chart";

const number = new Intl.NumberFormat("en-US");
function date(value: string) {
	return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}
export function AnalyticsView({
	data,
	filters,
	eventNames,
}: {
	data: Analytics;
	filters: Filters;
	eventNames: string[];
}) {
	const kpis = [
		{
			label: "Events",
			value: data.totals.events,
			note: "Recorded in this period",
			icon: "↗",
		},
		{
			label: "Active people",
			value: data.totals.activeUsers,
			note: "Unique people in this period",
			icon: "◎",
		},
		{
			label: "Sessions",
			value: data.totals.sessions,
			note: "Distinct sessions in this period",
			icon: "◷",
		},
		{
			label: "Events today",
			value: data.totals.eventsToday,
			note: "Today so far · UTC",
			icon: "✧",
		},
	];
	const maxEvents = Math.max(1, ...data.topEvents.map((item) => item.count));
	const firstFunnel = data.funnel[0]?.users ?? 0;
	const funnelSteps = data.funnel.map((step, index) => ({
		...step,
		sequenceKey: data.funnel
			.slice(0, index + 1)
			.map((entry) => entry.name)
			.join("/"),
	}));
	return (
		<>
			<section id="overview" className="kpi-grid" aria-label="Key metrics">
				{kpis.map((kpi) => (
					<article className="kpi" key={kpi.label}>
						<div className="kpi-top">
							<span>{kpi.label}</span>
							<span className="metric-icon" aria-hidden="true">
								{kpi.icon}
							</span>
						</div>
						<strong>{number.format(kpi.value)}</strong>
						<p>{kpi.note}</p>
					</article>
				))}
			</section>
			<div className="active-strip">
				<span>
					<i className="live-dot" />
					Activity at a glance
				</span>
				<p>
					<strong>{number.format(data.totals.activeToday)}</strong> active today
				</p>
				<p>
					<strong>{number.format(data.totals.active7Days)}</strong> in the last 7 days
				</p>
				<p>
					<strong>{number.format(data.totals.active30Days)}</strong> in the last 30 days
				</p>
			</div>
			<section id="activity" className="panel activity-panel">
				<div className="panel-header">
					<div>
						<h2>A little more clarity, every day.</h2>
						<p>
							{date(data.from)} – {date(data.to)} · UTC
							{filters.event ? ` · ${filters.event}` : ""}
						</p>
					</div>
					<div className="legend">
						<span>
							<i className="legend-dot events-dot" />
							Events
						</span>
						<span>
							<i className="legend-dot people-dot" />
							Active people
						</span>
					</div>
				</div>
				{data.totals.events === 0 ? (
					<div className="empty-chart">
						<span aria-hidden="true">◌</span>
						<h3>Your story starts with the first event.</h3>
						<p>
							No activity was recorded for these filters. Try another environment or date range.
						</p>
					</div>
				) : (
					<ActivityChart daily={data.daily} />
				)}
			</section>
			<div className="two-column">
				<section className="panel" aria-labelledby="events-heading">
					<div className="panel-header">
						<div>
							<h2 id="events-heading">What people do</h2>
							<p>Events ranked by volume in this period</p>
						</div>
						<span className="eyebrow">FEATURE USE</span>
					</div>
					<div className="event-list">
						{data.topEvents.length ? (
							data.topEvents.map((event, i) => (
								<div className="event-row" key={event.name}>
									<span className="event-number">{String(i + 1).padStart(2, "0")}</span>
									<div className="event-body">
										<div className="event-title">
											<code>{event.name}</code>
											<strong>{number.format(event.count)}</strong>
										</div>
										<div className="event-bar">
											<span style={{ width: `${(event.count / maxEvents) * 100}%` }} />
										</div>
										<small>{number.format(event.users)} unique people</small>
									</div>
								</div>
							))
						) : (
							<p className="empty-text">Recorded events will appear here.</p>
						)}
					</div>
				</section>
				<section id="funnel" className="panel">
					<div className="panel-header">
						<div>
							<h2>From first step to next step</h2>
							<p>Follow a sequence of events across this period</p>
						</div>
						<span className="eyebrow">FUNNEL</span>
					</div>
					<form
						className="funnel-form"
						method="get"
						key={`${data.app.slug}:${filters.funnel.join(",")}`}
					>
						<input type="hidden" name="app" value={data.app.slug} />
						<input type="hidden" name="range" value={filters.range} />
						<input type="hidden" name="environment" value={filters.environment} />
						{filters.event && <input type="hidden" name="event" value={filters.event} />}
						<label htmlFor="funnel-events">Event names in order, separated by commas</label>
						<div>
							<input
								id="funnel-events"
								name="funnel"
								defaultValue={filters.funnel.join(",")}
								placeholder="app_opened, project_created"
								maxLength={324}
							/>
							<button type="submit">Apply</button>
						</div>
						<small>Choose 2–5 events. Available: {eventNames.join(", ") || "none yet"}.</small>
					</form>
					{data.funnel.length ? (
						<ol className="funnel-list">
							{funnelSteps.map((step, index) => (
								<li key={step.sequenceKey}>
									<div>
										<span className="step-index">{index + 1}</span>
										<code>{step.name}</code>
										<strong>{number.format(step.users)}</strong>
									</div>
									<div className="funnel-track">
										<span
											style={{
												width: `${firstFunnel ? (step.users / firstFunnel) * 100 : 0}%`,
											}}
										/>
									</div>
									<small>
										{step.conversionRate === null
											? "No preceding activity"
											: index === 0
												? "People who started the sequence"
												: `${percent(step.conversionRate)} from the previous step`}
									</small>
								</li>
							))}
						</ol>
					) : (
						<p className="empty-text">
							Choose a sequence to see where people continue. Steps must happen in order; this is a
							people funnel, not an event count.
						</p>
					)}
				</section>
			</div>
			<section id="retention" className="panel">
				<div className="panel-header">
					<div>
						<h2>Who comes back?</h2>
						<p>
							People grouped by their first recorded activity. Cells show the share returning on
							that exact day.
						</p>
					</div>
					<span className="eyebrow">RETENTION</span>
				</div>
				{data.retention.length ? (
					<div className="table-scroll retention-scroll">
						<table className="retention-table">
							<caption className="sr-only">
								Daily retention cohorts. A dash means the full return day has not elapsed.
							</caption>
							<thead>
								<tr>
									<th>First active</th>
									<th>People</th>
									<th>Day 1</th>
									<th>Day 7</th>
									<th>Day 30</th>
								</tr>
							</thead>
							<tbody>
								{data.retention.map((cohort) => (
									<tr key={cohort.cohortDate}>
										<th scope="row">{date(cohort.cohortDate)}</th>
										<td>{number.format(cohort.users)}</td>
										{(["day1", "day7", "day30"] as const).map((key) => (
											<td key={key}>
												<span
													className={`retention-cell ${cohort[key] === null ? "immature" : ""}`}
													title={percent(cohort[key])}
													style={
														cohort[key] === null
															? undefined
															: {
																	backgroundColor: `rgba(62,117,108,${0.08 + cohort[key] * 0.5})`,
																}
													}
												>
													{cohort[key] === null ? "—" : percent(cohort[key])}
												</span>
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p className="empty-text">Retention appears after people start using the app.</p>
				)}
				<p className="panel-footnote">
					— Not yet mature. Retention measures observed activity, not app installation dates.
					Today's cohorts are still in progress.
				</p>
			</section>
			<footer className="data-footer">
				<span>Recorded activity only. All dates use UTC.</span>
				<span>
					{data.coverage.firstEventAt
						? `First event: ${new Date(data.coverage.firstEventAt).toLocaleDateString("en-US", { timeZone: "UTC" })}`
						: "No events received yet"}
				</span>
			</footer>
		</>
	);
}
