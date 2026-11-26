import { describe, expect, it } from "vitest";
import { newPasswordPage, resetRequestPage, signInLinkPage, signInPage, signUpPage } from "./http";

const text = (r: Response) => r.text();
const blank = { name: "", businessName: "", email: "" };

describe("auth page markup", () => {
  it("keeps the form fields, names and autocomplete values password managers rely on", async () => {
    const up = await text(signUpPage(blank));
    for (const n of ["name", "businessName", "email", "password", "terms"]) expect(up).toContain(`name="${n}"`);
    expect(up).toContain('autocomplete="new-password" required minlength="12" maxlength="256"');
    expect(up).toContain("At least 12 characters");
    const signIn = await text(signInPage());
    expect(signIn).toContain('autocomplete="username"');
    expect(signIn).toContain('autocomplete="current-password"');
    expect(signIn).not.toContain("minlength");
    expect(await text(newPasswordPage())).toContain('autocomplete="new-password"');
    // forms post back to their own URL
    for (const p of [up, signIn, await text(signInLinkPage()), await text(resetRequestPage())])
      expect(p).toContain('<form method="post">');
  });

  it("links the four pages to each other", async () => {
    const signIn = await text(signInPage());
    for (const href of ["/account/reset", "/account/sign-in/link", "/account/register"])
      expect(signIn).toContain(`href="${href}"`);
    expect(signIn).toContain('class="back" href="/"');
    for (const p of [signUpPage(blank), signInLinkPage(), resetRequestPage(), newPasswordPage()])
      expect(await text(p)).toContain('class="back" href="/account/sign-in"');
  });

  it("ties a field's error to that field", async () => {
    const up = await text(signUpPage(blank, "Use at least 12 characters."));
    expect(up).toContain('aria-describedby="password-hint password-error" aria-invalid="true" autofocus');
    expect(up).toContain('<p class="field-error" id="password-error">Use at least 12 characters.</p>');
    expect(await text(signUpPage(blank, "Accept the terms and privacy policy to continue."))).toContain(
      'aria-invalid="true" aria-describedby="terms-error"',
    );
    expect(await text(resetRequestPage("Enter your email."))).toContain('aria-describedby="email-error"');
    expect(await text(newPasswordPage("Use at least 12 characters."))).toContain('id="password-error"');
  });

  it("shows a sign-in error above the form, described by both fields", async () => {
    const p = await text(signInPage("a@b.test", "That email and password do not match an account.", 401));
    expect(p).toContain('id="form-error" role="alert"');
    expect(p.match(/aria-describedby="form-error"/g)).toHaveLength(2);
  });
});
