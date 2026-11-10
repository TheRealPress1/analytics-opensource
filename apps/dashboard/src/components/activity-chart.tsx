"use client";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { Analytics } from "../lib/schema";

export function ActivityChart({ daily }: { daily: Analytics["daily"] }) {
	return (
		<>
			<section
				className="chart"
				aria-label="Daily events and active people. Exact values are available in the table below."
			>
				<ResponsiveContainer width="100%" height={280}>
					<ComposedChart
						data={daily}
						margin={{ top: 12, right: 8, bottom: 8, left: -20 }}
						accessibilityLayer
					>
						<defs>
							<linearGradient id="eventFill" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor="#c85e39" stopOpacity={0.2} />
								<stop offset="100%" stopColor="#c85e39" stopOpacity={0.01} />
							</linearGradient>
						</defs>
						<CartesianGrid vertical={false} stroke="#ece8e2" strokeDasharray="3 3" />
						<XAxis
							dataKey="date"
							tickFormatter={(value: string) => value.slice(5)}
							tickLine={false}
							axisLine={false}
							minTickGap={38}
							tick={{ fill: "#777b78", fontSize: 12 }}
						/>
						<YAxis
							allowDecimals={false}
							tickLine={false}
							axisLine={false}
							tick={{ fill: "#777b78", fontSize: 12 }}
						/>
						<Tooltip
							contentStyle={{
								borderRadius: 12,
								border: "1px solid #e1dfda",
								fontSize: 13,
							}}
							labelFormatter={(date) => `${date} · UTC`}
						/>
						<Area
							type="linear"
							dataKey="events"
							name="Events"
							stroke="#b74927"
							strokeWidth={2.5}
							fill="url(#eventFill)"
							isAnimationActive={false}
						/>
						<Line
							type="linear"
							dataKey="activeUsers"
							name="Active people"
							stroke="#3e756c"
							strokeWidth={2}
							dot={daily.length === 1}
							isAnimationActive={false}
						/>
					</ComposedChart>
				</ResponsiveContainer>
			</section>
			<details className="data-disclosure">
				<summary>View daily data</summary>
				<div className="table-scroll">
					<table>
						<caption className="sr-only">Daily analytics in UTC</caption>
						<thead>
							<tr>
								<th>Date</th>
								<th>Events</th>
								<th>Active people</th>
								<th>Sessions</th>
							</tr>
						</thead>
						<tbody>
							{daily.map((day) => (
								<tr key={day.date}>
									<th scope="row">{day.date}</th>
									<td>{day.events}</td>
									<td>{day.activeUsers}</td>
									<td>{day.sessions}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</>
	);
}
