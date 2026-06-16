/** Default ELO for new players and new semesters. Set via DEFAULT_ELO env var. */
export const DEFAULT_ELO: number = parseInt(process.env.DEFAULT_ELO ?? '1000', 10);
