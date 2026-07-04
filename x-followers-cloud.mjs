// 抓 X 公开主页的粉丝数(无登录)。输出纯数字;失败输出空并退出码 1。
import puppeteer from 'puppeteer-core';

const HANDLE = process.argv[2] || 'raysonmeng';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-first-run', '--lang=en-US', '--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await page.goto(`https://x.com/${HANDLE}`, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));
  const n = await page.evaluate(() => {
    // 路线1:页面内嵌状态 JSON
    const m = document.documentElement.innerHTML.match(/"followers_count":(\d+)/);
    if (m) return parseInt(m[1], 10);
    // 路线2:followers 链接的可见文本(如 "1,234 Followers")
    for (const a of document.querySelectorAll('a[href*="followers"]')) {
      const t = a.textContent.replace(/,/g, '');
      const mm = t.match(/([\d.]+)([KM]?)\s*Followers/i);
      if (mm) {
        let v = parseFloat(mm[1]);
        if (mm[2] === 'K') v *= 1e3; if (mm[2] === 'M') v *= 1e6;
        return Math.round(v);
      }
    }
    return null;
  });
  if (n == null) { console.error('not found'); process.exit(1); }
  process.stdout.write(String(n) + "\n");
} finally {
  await browser.close();
}
