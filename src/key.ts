/** ADR-0001: stable normalized lemma identity. */
export const normalizeKey = (lemma: string) =>
  "en:" + lemma.toLowerCase().normalize("NFC").replace(/[‘’]/g, "'");
