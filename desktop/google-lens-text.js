// Evaluated only inside Google's result area, never the account header or other tabs.
root => {
  const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[aria-hidden="true"]');
  const text = node => visible(node) ? (node.innerText || '').trim() : '';
  const aiHeading = /^(?:AI Overview|AI overview|AI-generated overview|AI 摘要|AI摘要|AI 概览|AI概览|AI 概要|AI概要)$/i;
  let overview = null;
  const headings = root.querySelectorAll('h1,h2,h3,[role="heading"],span');
  for (const heading of headings) {
    if (!aiHeading.test(text(heading))) continue;
    // Stop at the result root: never mistake all search results for an overview.
    let section = heading.parentElement;
    for (let depth = 0; section && section !== root && depth < 6; depth++, section = section.parentElement) {
      if (section.querySelector('h1,h2,h3,[role="heading"]:not([aria-hidden="true"])') &&
          [...section.querySelectorAll('h1,h2,h3,[role="heading"]')].some(node => /^(Visual matches|Images|视觉匹配|視覺相符結果|图片)$/i.test(text(node)))) break;
      const body = text(section);
      if (body.length > 12000) break;
      const hasBody = section.querySelector('p,li,[data-attrid],[data-snf],[data-sfc-cp]') ||
        [...section.children].some(child => child !== heading && !child.contains(heading) && text(child).length > 35);
      if (body.length > text(heading).length + 35 && hasBody) {
        overview = { text: body.replace(/^(?:AI Overview|AI-generated overview|AI\s*[摘要概览要]{2})\s*/i, '').trim().slice(0, 6000),
          sources: [...section.querySelectorAll('a[href]')].filter(visible).map(node => node.href).slice(0, 20) };
        break;
      }
    }
    if (overview) break;
  }
  // Explicit description widgets only; ordinary match titles/snippets are not an image description.
  const descriptions = [...root.querySelectorAll('[data-attrid="description"],[data-attrid="wa:/description"],.kno-rdesc')]
    .filter(node => !/^(?:AI Overview|AI 摘要)/i.test(text(node))).map(text).filter(Boolean);
  return { description: descriptions.length ? [...new Set(descriptions)].join('\n').slice(0, 2000) : null, ai_overview: overview };
}
