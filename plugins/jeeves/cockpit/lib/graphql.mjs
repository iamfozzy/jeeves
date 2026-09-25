// GraphQL document checks for the cockpit's github_read tool, which runs caller-supplied
// queries and must never run a write.

// The top-level fields of every mutation in a GraphQL document; null when it doesn't parse.
export function gqlMutations(q) {
  const fields = []
  let depth = 0, paren = 0, mut = false, inMut = false, word = ''
  const flush = () => {
    if (!word) return
    if (depth === 0 && paren === 0) { if (word === 'mutation') mut = true; else if (['query', 'subscription', 'fragment'].includes(word)) mut = false }
    else if (inMut && depth === 1 && paren === 0) fields.push(word)
    word = ''
  }
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    if (c === '"') { // a string, or a """ block string, is data
      flush()
      const block = q.startsWith('"""', i)
      let j = block ? q.indexOf('"""', i + 3) : i + 1
      if (!block) while (j < q.length && q[j] !== '"') j += q[j] === '\\' ? 2 : 1
      if (j < 0 || j >= q.length) return null
      i = block ? j + 2 : j; continue
    }
    if (c === '#') { flush(); const j = q.indexOf('\n', i); i = j < 0 ? q.length : j; continue }
    if (/[A-Za-z0-9_]/.test(c)) { word += c; continue }
    if (c === ':' && word && depth === 1 && paren === 0) { word = ''; continue } // an alias: the field name follows
    flush()
    if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === '{' && paren === 0) { if (depth === 0) inMut = mut; depth++ }
    else if (c === '}' && paren === 0) { if (--depth === 0) { inMut = false; mut = false } }
    if (depth < 0 || paren < 0) return null
  }
  flush()
  return depth === 0 && paren === 0 ? fields : null
}
