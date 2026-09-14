/**
 * bart's algorithm in JavaScript, for a same-language comparison.
 *
 * A stride-8 multibit trie. At each level the 256 possible octet values and
 * the 9 possible prefix lengths within the stride are folded into one complete
 * binary tree by Knuth's ART numbering:
 *
 *     baseIndex(octet, len) = (octet >> (8 - len)) | (1 << len)
 *
 * which puts a /0 at index 1, the two /1s at 2..3, the four /2s at 4..7, and
 * so on — heap order. Finding the longest match within a stride is then just
 * walking that index towards the root by halving it, which is why prefix
 * length never has to be searched for.
 *
 * Both the prefix set and the child set are popcount-compressed: a bitset says
 * which slots exist, and the value lives at the rank of its bit, so a sparse
 * level costs no more than it uses.
 */

function baseIndex(octet, len) {
  return (octet >>> (8 - len)) | (1 << len);
}

/** Bits set in `words[0..n)` below bit `bit`. */
function rank(words, bit) {
  let r = 0;
  const w = bit >>> 5;
  for (let i = 0; i < w; i++) r += popcount(words[i]);
  r += popcount(words[w] & ((1 << (bit & 31)) - 1));
  return r;
}

function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

class Node {
  constructor() {
    this.pfxBits = new Uint32Array(16); // 512 slots, ART indices
    this.pfxVals = [];
    this.childBits = new Uint32Array(8); // 256 slots
    this.children = [];
  }

  hasPfx(i) {
    return (this.pfxBits[i >>> 5] & (1 << (i & 31))) !== 0;
  }

  setPfx(i, v) {
    const r = rank(this.pfxBits, i);
    if (this.hasPfx(i)) {
      this.pfxVals[r] = v;
      return;
    }
    this.pfxBits[i >>> 5] |= 1 << (i & 31);
    this.pfxVals.splice(r, 0, v);
  }

  getPfx(i) {
    return this.pfxVals[rank(this.pfxBits, i)];
  }

  hasChild(o) {
    return (this.childBits[o >>> 5] & (1 << (o & 31))) !== 0;
  }

  child(o) {
    return this.children[rank(this.childBits, o)];
  }

  addChild(o) {
    const r = rank(this.childBits, o);
    if (this.hasChild(o)) return this.children[r];
    this.childBits[o >>> 5] |= 1 << (o & 31);
    const n = new Node();
    this.children.splice(r, 0, n);
    return n;
  }
}

export class BartJS {
  constructor() {
    this.root = new Node();
  }

  insert(addr, len, value) {
    let n = this.root;
    let depth = 0;
    for (;;) {
      const octet = (addr >>> (24 - depth * 8)) & 255;
      const remaining = len - depth * 8;
      if (remaining <= 8) {
        n.setPfx(baseIndex(octet, remaining), value);
        return;
      }
      n = n.addChild(octet);
      depth++;
    }
  }

  /** Longest-prefix match. Returns the value, or 0. */
  lookup(addr) {
    let n = this.root;
    let depth = 0;
    let best = 0;
    for (;;) {
      const octet = (addr >>> (24 - depth * 8)) & 255;

      // Longest match within this stride: walk the ART index to the root.
      let i = baseIndex(octet, 8);
      while (i > 0) {
        if (n.hasPfx(i)) {
          best = n.getPfx(i);
          break;
        }
        i >>>= 1;
      }

      if (depth === 3 || !n.hasChild(octet)) return best;
      n = n.child(octet);
      depth++;
    }
  }
}
