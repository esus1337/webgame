import { expect, test, type Page } from '@playwright/test';

/**
 * One pass over the things that can only be verified in a real browser: that
 * the canvas actually paints, that the simulation advances, and that the
 * tap-tap order flow works with both a mouse and a finger.
 */

const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const collected: string[] = [];
  errors.set(page, collected);
  page.on('console', (message) => {
    if (message.type() === 'error') collected.push(message.text());
  });
  page.on('pageerror', (error) => collected.push(`pageerror: ${error.message}`));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Province Conquest' })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? []).toEqual([]);
});

/** Proportion of non-background pixels, as a crude "did anything render" check. */
async function mapCoverage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.map') as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    // Sample a grid rather than every pixel; this runs on a 2x backing store.
    for (let i = 0; i < data.length; i += 4 * 97) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 40 || g > 40 || b > 55) painted++;
    }
    return painted / Math.ceil(data.length / (4 * 97));
  });
}

async function begin(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByRole('heading', { name: 'Province Conquest' })).toBeHidden();
}

function currentDay(page: Page): Promise<number> {
  return page.evaluate(() => {
    const text = document.querySelector('.date')?.textContent ?? '';
    const match = /D(\d+)/.exec(text);
    return match ? Number(match[1]) : -1;
  });
}

test('renders a generated world behind the start screen', async ({ page }) => {
  expect(await mapCoverage(page)).toBeGreaterThan(0.05);
  // One chip per nation, each offering a country to play.
  const chips = page.locator('.nation-chip');
  await expect(chips.first()).toBeVisible();
  expect(await chips.count()).toBeGreaterThanOrEqual(4);
});

test('a seed reproduces the same world', async ({ page }) => {
  const seedField = page.getByLabel('World seed');
  await seedField.fill('a-fixed-seed');
  await seedField.press('Enter');
  await page.waitForTimeout(400);
  const first = await page.locator('.nation-chip-name').allTextContents();

  await page.getByRole('button', { name: 'Shuffle' }).click();
  await page.waitForTimeout(300);
  await seedField.fill('a-fixed-seed');
  await seedField.press('Enter');
  await page.waitForTimeout(400);

  expect(await page.locator('.nation-chip-name').allTextContents()).toEqual(first);
});

test('runs the simulation and honours pause', async ({ page }) => {
  await begin(page);
  await page.waitForTimeout(1500);
  const running = await currentDay(page);
  expect(running).toBeGreaterThan(0);

  await page.keyboard.press(' ');
  const paused = await currentDay(page);
  await page.waitForTimeout(1200);
  expect(await currentDay(page)).toBe(paused);

  await page.keyboard.press(' ');
  await page.waitForTimeout(1200);
  expect(await currentDay(page)).toBeGreaterThan(paused);
});

test('speed controls change how fast days pass', async ({ page }) => {
  await begin(page);
  await page.keyboard.press('1');
  await page.waitForTimeout(200);

  const slowStart = await currentDay(page);
  await page.waitForTimeout(2000);
  const slowElapsed = (await currentDay(page)) - slowStart;

  await page.keyboard.press('3');
  const fastStart = await currentDay(page);
  await page.waitForTimeout(2000);
  const fastElapsed = (await currentDay(page)) - fastStart;

  expect(fastElapsed).toBeGreaterThan(slowElapsed);
});

test('selecting a province opens the details panel', async ({ page }) => {
  await begin(page);
  await page.keyboard.press(' ');

  const viewport = page.viewportSize()!;
  await page.mouse.click(viewport.width / 2, viewport.height / 2);

  const panel = page.locator('.panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.panel-title')).not.toBeEmpty();
  await expect(panel.getByText('Terrain')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('recruiting spends the manpower pool', async ({ page }) => {
  await begin(page);
  await page.keyboard.press(' ');

  // Find a province the player owns and select it through the game's own API
  // surface — clicking blind would usually land on someone else's territory.
  const found = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.map') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(found.width).toBeGreaterThan(0);

  // The player's nation is centred on screen at the start of a game, so walk a
  // small grid outward from the middle until a province with a Recruit button
  // is selected.
  const recruit = page.getByRole('button', { name: /^Recruit/ });
  let opened = false;
  for (let radius = 0; radius <= 3 && !opened; radius++) {
    for (let dx = -radius; dx <= radius && !opened; dx++) {
      for (let dy = -radius; dy <= radius && !opened; dy++) {
        await page.mouse.click(
          found.width / 2 + dx * found.width * 0.09,
          found.height / 2 + dy * found.height * 0.09,
        );
        opened = await recruit.isVisible();
      }
    }
  }
  expect(opened).toBe(true);

  const manpowerBefore = await page.locator('.stat-value').first().textContent();
  await recruit.click();
  const manpowerAfter = await page.locator('.stat-value').first().textContent();
  expect(Number(manpowerAfter)).toBeLessThan(Number(manpowerBefore));
});

test('a finger tap selects a province', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'exercises the touch path specifically');

  await begin(page);
  await page.keyboard.press(' ');

  const viewport = page.viewportSize()!;
  await page.touchscreen.tap(viewport.width / 2, viewport.height / 2);

  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.panel-title')).not.toBeEmpty();
});

test('autosaves and restores after a reload', async ({ page }) => {
  await begin(page);
  await page.keyboard.press('3');

  // Wait past the autosave interval, then check the save is actually written.
  await expect
    .poll(
      () => page.evaluate(() => window.localStorage.getItem('province-conquest:save:v1') !== null),
      { timeout: 15_000 },
    )
    .toBe(true);

  const nation = await page.locator('.identity-name').textContent();
  const savedDay = await page.evaluate(() => {
    const raw = window.localStorage.getItem('province-conquest:save:v1');
    return raw ? (JSON.parse(raw) as { day: number }).day : -1;
  });
  expect(savedDay).toBeGreaterThan(0);

  await page.reload();
  const resume = page.getByRole('button', { name: 'Continue saved game' });
  await expect(resume).toBeVisible();
  await resume.click();

  await expect(page.getByRole('heading', { name: 'Province Conquest' })).toBeHidden();
  expect(await page.locator('.identity-name').textContent()).toBe(nation);
  expect(await currentDay(page)).toBe((savedDay % 360) + 1);
  // A restored game comes back paused, so the player can take stock.
  await expect(page.locator('.speed-button.pause')).toHaveText('▶');
});

test('the pause menu resumes without offering to change the world', async ({ page }) => {
  await begin(page);
  await page.waitForTimeout(600);
  const before = await currentDay(page);

  await page.locator('.identity').click();
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();
  // Mid-game the world settings are gone; only resume or start over.
  await expect(page.getByLabel('World seed')).toBeHidden();
  await expect(page.locator('.nation-list')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Continue saved game' })).toBeHidden();

  // The simulation is held while the menu is up.
  const held = await currentDay(page);
  await page.waitForTimeout(900);
  expect(await currentDay(page)).toBe(held);
  expect(held).toBeGreaterThanOrEqual(before);

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeHidden();
  await page.waitForTimeout(900);
  expect(await currentDay(page)).toBeGreaterThan(held);
});

test('resuming restores the pause state the player left', async ({ page }) => {
  await begin(page);
  await page.keyboard.press(' '); // pause deliberately
  await expect(page.locator('.speed-button.pause')).toHaveText('▶');

  await page.locator('.identity').click();
  await page.getByRole('button', { name: 'Resume' }).click();

  // The player paused before opening the menu, so they get a paused game back.
  await expect(page.locator('.speed-button.pause')).toHaveText('▶');
  const day = await currentDay(page);
  await page.waitForTimeout(900);
  expect(await currentDay(page)).toBe(day);
});

test('zooming changes how much of the map is on screen', async ({ page }) => {
  await begin(page);
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);

  // Comparing screenshots is not enough: battle pulses and dashed outlines keep
  // animating while paused, so a broken zoom would still produce a different
  // image. Measuring how much land fills the view actually tests the camera.
  const before = await mapCoverage(page);
  for (let i = 0; i < 8; i++) await page.keyboard.press('=');
  await page.waitForTimeout(400);
  const zoomedIn = await mapCoverage(page);

  expect(zoomedIn).toBeGreaterThan(before + 0.05);

  for (let i = 0; i < 14; i++) await page.keyboard.press('-');
  await page.waitForTimeout(400);
  expect(await mapCoverage(page)).toBeLessThan(zoomedIn - 0.05);
});

test('zoom still works after generating a different world', async ({ page }) => {
  // Regression: starting a new world replaces the Camera, and input used to
  // keep driving the discarded one, which killed pan and zoom.
  const seedField = page.getByLabel('World seed');
  await seedField.fill('a-different-world');
  await seedField.press('Enter');
  await page.waitForTimeout(400);
  await begin(page);
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);

  const before = await mapCoverage(page);
  for (let i = 0; i < 8; i++) await page.keyboard.press('=');
  await page.waitForTimeout(400);
  expect(await mapCoverage(page)).toBeGreaterThan(before + 0.05);
});

test('dragging pans the map', async ({ page }) => {
  // A fixed seed keeps the geometry identical between runs; with the random
  // seed the map differs every time and the assertion below is a coin toss.
  const seedField = page.getByLabel('World seed');
  await seedField.fill('pan-fixture');
  await seedField.press('Enter');
  await page.waitForTimeout(400);
  await begin(page);
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);

  const box = (await page.locator('canvas.map').boundingBox())!;
  const centreX = box.width / 2;
  const centreY = box.height * 0.42;
  const panel = page.locator('.panel');
  const title = page.locator('.panel-title');

  // Which province sits under a fixed point is a direct read on where the
  // camera is looking — and unlike pixel coverage it works on a phone, where
  // land fills the view both before and after the drag.
  await page.mouse.click(centreX, centreY);
  await expect(panel).toBeVisible();
  const before = await title.textContent();

  await page.mouse.move(centreX + box.width * 0.3, centreY);
  await page.mouse.down();
  await page.mouse.move(centreX - box.width * 0.3, centreY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  await page.mouse.click(centreX, centreY);
  // Landing on open sea closes the panel, which is equally proof the view moved.
  const stillOnLand = await panel.isVisible();
  const now = stillOnLand ? await title.textContent() : null;
  expect(now).not.toBe(before);
});

test('the map survives a resize', async ({ page }) => {
  await begin(page);
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(400);
  expect(await mapCoverage(page)).toBeGreaterThan(0.05);
  await expect(page.locator('.topbar')).toBeVisible();
});
