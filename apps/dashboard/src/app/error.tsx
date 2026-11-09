"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
	return (
		<main className="access-page">
			<section className="access-card" role="alert">
				<h1>This view couldn't load.</h1>
				<p>Please try again. No event data was changed.</p>
				<button className="primary-button" type="button" onClick={reset}>
					Try again
				</button>
			</section>
		</main>
	);
}
