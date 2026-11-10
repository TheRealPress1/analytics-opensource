"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { Filters } from "../lib/policy";
import type { AppChoice } from "../lib/schema";

export function FiltersBar({
	apps,
	app,
	filters,
	eventNames,
}: {
	apps: AppChoice[];
	app: string;
	filters: Filters;
	eventNames: string[];
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	function change(key: string, value: string) {
		const query = new URLSearchParams({
			app,
			range: filters.range,
			environment: filters.environment,
		});
		if (filters.event) query.set("event", filters.event);
		if (filters.funnel.length) query.set("funnel", filters.funnel.join(","));
		if (value) query.set(key, value);
		else query.delete(key);
		if (key === "app") {
			query.delete("event");
			query.delete("funnel");
		}
		startTransition(() => router.replace(`/?${query}`, { scroll: false }));
	}
	const labels = [
		["today", "Today"],
		["7", "7 days"],
		["30", "30 days"],
		["90", "90 days"],
		["all", "All time"],
	] as const;
	return (
		<div className="filter-bar" aria-busy={pending}>
			<div className="filter-selects">
				<label className="select-label">
					Application
					<select value={app} onChange={(e) => change("app", e.target.value)} disabled={pending}>
						{apps.map((item) => (
							<option key={item.slug} value={item.slug}>
								{item.name}
							</option>
						))}
					</select>
				</label>
				<label className="select-label">
					Environment
					<select
						value={filters.environment}
						onChange={(e) => change("environment", e.target.value)}
						disabled={pending}
					>
						<option value="development">Development</option>
						<option value="production">Production</option>
					</select>
				</label>
				<label className="select-label">
					Event
					<select
						value={filters.event ?? ""}
						onChange={(e) => change("event", e.target.value)}
						disabled={pending}
					>
						<option value="">All events</option>
						{eventNames.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				</label>
			</div>
			<fieldset className="range-buttons">
				<legend className="sr-only">Date range</legend>
				{labels.map(([value, label]) => (
					<button
						key={value}
						type="button"
						aria-pressed={filters.range === value}
						disabled={pending}
						onClick={() => change("range", value)}
					>
						{label}
					</button>
				))}
			</fieldset>
			<button
				className="refresh-button"
				type="button"
				disabled={pending}
				onClick={() => startTransition(() => router.refresh())}
			>
				<span aria-hidden="true">↻</span> Refresh
			</button>
			<span className="sr-only" role="status">
				{pending ? "Updating analytics" : "Analytics ready"}
			</span>
		</div>
	);
}
