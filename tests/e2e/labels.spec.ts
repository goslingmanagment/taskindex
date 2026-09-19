import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { command, signIn, snapshot } from './helpers';

// 0007: the owner manages the label catalogue in the «Метки» dialog. A new
// label appears in the editor picker and on the card at once; archiving it
// takes it off the card without a reload.
test('the owner creates a label in the dialog, puts it on a task and archives it', async ({
  page,
}, info) => {
  await signIn(page, info, '/?area=agency&project=all&view=board');
  const suffix = randomUUID().slice(0, 6);
  const name = `Срочно ${suffix}`;
  const taskId = randomUUID();
  const title = `Метка на карточке ${suffix}`;
  await command(page, 'task.create', { id: taskId, area: 'agency', title });
  const card = page
    .locator('article.task-card')
    .filter({ has: page.locator(`[data-task-open="${taskId}"]`) });
  await expect(card).toBeVisible();

  await page
    .getByRole('button', { name: 'Настройки доски', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Метки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Метки', exact: true });
  await expect(dialog).toBeVisible();
  // The seeded catalogue is listed with its usage.
  await expect(dialog.getByText('деньги', { exact: true })).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Новая метка', exact: true })
    .click();
  await dialog.getByRole('textbox', { name: 'Название метки' }).fill(name);
  await expect(dialog.locator('.label-slug code')).toHaveText(
    `srochno-${suffix}`,
  );
  await dialog
    .getByRole('textbox', { name: 'Когда ставить метку' })
    .fill('Ждёт ответа сегодня');
  await dialog
    .getByRole('button', { name: 'Добавить метку', exact: true })
    .click();
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await expect(dialog.getByText('не используется')).toHaveCount(6);
  await expect
    .poll(async () => (await snapshot(page)).labels.map((label) => label.id))
    .toContain(`srochno-${suffix}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The editor picker lists the new label; saving shows it on the card.
  await card.locator('.card-open').click();
  await page.getByRole('button', { name: 'Метка', exact: true }).click();
  await page
    .getByRole('menuitemcheckbox', { name: `Метка: ${name}`, exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  await expect(card.locator('.label-chip')).toHaveText([name]);

  // Archiving from the dialog clears the chip in the same operation.
  await page
    .getByRole('button', { name: 'Настройки доски', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Метки', exact: true }).click();
  await expect(dialog.getByText('1 задача', { exact: true })).toBeVisible();
  await dialog
    .getByRole('button', { name: `В архив: метка ${name}`, exact: true })
    .click();
  await expect(dialog.getByText(`В архиве: 1`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.locator('.label-chip')).toHaveCount(0);
  await expect
    .poll(async () => {
      const state = await snapshot(page);
      return {
        archived: state.labels.find((l) => l.id === `srochno-${suffix}`)
          ?.archivedAt,
        labels: state.tasks.find((t) => t.id === taskId)?.labels,
      };
    })
    .toMatchObject({ archived: expect.any(String), labels: [] });
  await command(page, 'task.archive', {
    id: taskId,
    baseRevision: (await snapshot(page)).tasks.find((t) => t.id === taskId)!
      .revision,
  });
});
