// Review request wording (SPEC FR-6, FR-7, Flow 2). Every message names the business, carries the review link
// (through our click-counting redirect) and the opt-out; it never offers an incentive, names staff or asks for
// specific content. Wording is in the customer's language when known (English and Spanish), otherwise English.
import type { EmailMessage } from "../email/provider";

export type Lang = "en" | "es";
export type Attempt = 1 | 2; // 1 = the request, 2 = the one reminder

export function pickLanguage(language: string | null | undefined): Lang {
  return language?.trim().toLowerCase().split(/[-_]/)[0] === "es" ? "es" : "en";
}

const SMS: Record<Lang, Record<Attempt, (business: string, link: string) => string>> = {
  en: {
    1: (b, l) => `${b}: thanks for choosing us. If you have a minute, would you leave us a Google review? ${l}`,
    2: (b, l) => `${b}: a quick reminder, if you have a minute, would you leave us a Google review? ${l}`,
  },
  es: {
    1: (b, l) => `${b}: gracias por elegirnos. Si tiene un minuto, ¿nos deja una reseña en Google? ${l}`,
    2: (b, l) => `${b}: un breve recordatorio, si tiene un minuto, ¿nos deja una reseña en Google? ${l}`,
  },
};
// FR-7's exact opt-out line, kept in English in every language: STOP is the keyword carriers and our webhook match.
const STOP = "Reply STOP to opt out.";

export function smsBody(lang: Lang, attempt: Attempt, business: string, link: string): string {
  return `${SMS[lang][attempt](business, link)} ${STOP}`;
}

const EMAIL: Record<
  Lang,
  { subject: (b: string) => string; intro: Record<Attempt, (b: string) => string>; button: string; footer: string }
> = {
  en: {
    subject: (b) => `Would you review ${b} on Google?`,
    intro: {
      1: (b) => `Thanks for choosing ${b}. If you have a minute, would you leave us a Google review?`,
      2: (b) => `A quick reminder from ${b}: if you have a minute, would you leave us a Google review?`,
    },
    button: "Leave a Google review",
    footer: "You are receiving this because you are a customer of",
  },
  es: {
    subject: (b) => `¿Nos deja una reseña de ${b} en Google?`,
    intro: {
      1: (b) => `Gracias por elegir ${b}. Si tiene un minuto, ¿nos deja una reseña en Google?`,
      2: (b) => `Un breve recordatorio de ${b}: si tiene un minuto, ¿nos deja una reseña en Google?`,
    },
    button: "Dejar una reseña en Google",
    footer: "Recibe este mensaje porque es cliente de",
  },
};
const UNSUBSCRIBE: Record<Lang, string> = { en: "Unsubscribe", es: "Cancelar suscripción (unsubscribe)" };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// CAN-SPAM (SPEC Compliance, FR-6): accurate sender, physical postal address and a working opt-out in every email.
export function reviewEmail(args: {
  lang: Lang;
  attempt: Attempt;
  business: string;
  to: string;
  link: string;
  unsubscribeUrl: string;
  postalAddress: string;
}): EmailMessage {
  const { lang, attempt, business, link, unsubscribeUrl, postalAddress } = args;
  const t = EMAIL[lang];
  const intro = t.intro[attempt](business);
  const footer = `${t.footer} ${business}.`;
  const text = [
    intro,
    "",
    `${t.button}: ${link}`,
    "",
    "--",
    footer,
    `${UNSUBSCRIBE[lang]}: ${unsubscribeUrl}`,
    postalAddress,
  ].join("\n");
  const html = `<!doctype html><html lang="${lang}"><body style="font-family:sans-serif;line-height:1.5">
<p>${esc(intro)}</p>
<p><a href="${esc(link)}">${esc(t.button)}</a></p>
<hr>
<p style="font-size:12px;color:#555">${esc(footer)}<br>
<a href="${esc(unsubscribeUrl)}">${esc(UNSUBSCRIBE[lang])}</a><br>
${esc(postalAddress)}</p>
</body></html>`;
  return {
    to: args.to,
    fromName: business,
    subject: t.subject(business),
    text,
    html,
    // RFC 8058 one-click unsubscribe: mail clients POST to the URL; our route handles that POST.
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
