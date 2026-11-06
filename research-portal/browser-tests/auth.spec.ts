import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Authentication requests in these tests are intercepted inside the browser.
  await page.route('https://*.supabase.co/**', (route) => route.abort());
});

test('sign-in submits the entered values and displays the authentication error', async ({ page }) => {
  await page.route('**/auth/v1/token?grant_type=password', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ email: 'test@example.invalid', password: 'test-only-password' });
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_credentials', message: 'Invalid login credentials' }) });
  });
  await page.goto('/portal?email=test%40example.invalid');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('test@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid login credentials');
});

test('password recovery keeps its form state and displays the reset confirmation', async ({ page }) => {
  await page.route('**/auth/v1/recover*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('/portal');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email', { exact: true }).fill('test@example.invalid');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists for this email');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('test@example.invalid');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
});

test('invite and password-setup URLs select their existing forms', async ({ page }) => {
  await page.goto('/portal?invite=test-only-token&email=test%40example.invalid');
  await expect(page.getByRole('heading', { name: 'Accept Invite' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept Invite', exact: true })).toBeDisabled();
  await page.goto('/portal?type=recovery');
  await expect(page.getByRole('heading', { name: 'Set Password' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Save Password' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use at least 8 characters.');
});
