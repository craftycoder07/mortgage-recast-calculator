# Mortgage Recast Calculator

**Live site:** https://craftycoder07.github.io/mortgage-recast-calculator/

A static, dependency-free calculator that compares three scenarios side by side:

- **No extra payments**
- **Recast**: the monthly payment is recalculated automatically after every lump sum. The loan still ends on its original date.
- **Lump Sums**: the same lump sums are paid, but the payment stays the same, so the loan is paid off sooner.

Unlike most recast calculators, it supports:

- **Multiple lump-sum payments**
- **A date (month/year) for each payment**
- **An optional recast fee, charged once per recast**

It also shows a payment timeline, a balance chart, and an amortization schedule you can expand by year.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Deploy

Every push to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`. One-time setup: in the repo, go to **Settings → Pages → Source** and choose **GitHub Actions**.
