export default async function ({ page }) {
  return { url: page.url(), title: await page.title() };
}
