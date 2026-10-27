/** Transport mentions and stored prompt headers are not evidence of a shared topic. */
export function recallText(text: string): string {
  return text.replace(/\[at:[^\]\r\n]*\]|\[(?:图片|image)\]/gi, ' ')
    .replace(/【(?:消息[｜|][^】]*|\d{4}-\d{2}-\d{2}[^】]*)】/g, ' ')
    .replace(/^(?:对方|你|user|assistant)[：:]\s*/gim, '')
    .trim()
}

/** Vague requests refer to the live conversation/image, not an arbitrary old episode. */
export function automaticRecallQuery(text: string): string {
  const query = recallText(text)
  const plain = query.replace(/[\s\p{P}\p{S}]/gu, '')
  if (!plain || /^(?:请|麻烦)?(?:你来|你|帮我|给我)?(?:回答|回复|说|看|看看|看下|分析|识别)(?:一?下|一下这个|这个|这张图|图片|吧|呢|啊|呀|呗)*$/u.test(plain)
    || /^(?:继续|继续说|然后呢|你觉得呢|你怎么看|这是什么|这是谁|这个呢|在吗|你好|hello|hi)$/iu.test(plain)
    || /^(?:你)?(?:能|看得|听得)?(?:看|听)?(?:懂|明白)(?:了)?(?:吗|么|没|没有|不)?$/u.test(plain)) return ''
  return query
}
