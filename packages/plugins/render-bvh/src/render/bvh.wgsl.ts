// Ray queries against the triangles buildBvh (bvh.ts) laid out: the closest hit, and whether
// anything is hit at all (for shadows). WGSL to put in front of a film's own shader, which
// declares the two storage buffers under these names, at any group and binding:
//
//   @group(0) @binding(0) var<storage, read> bvhNodes: array<vec4f>;
//   @group(0) @binding(1) var<storage, read> bvhTriangles: array<vec4f>;
//
// Traversal keeps a stack of BVH_DEPTH nodes, the deepest tree buildBvh makes, and visits the
// nearer child first. Triangles are Möller–Trumbore, two-sided. A hit lies strictly between
// tMin and tMax.

export const BVH_WGSL = /* wgsl */ `
const BVH_MISS = 0xffffffffu;
const BVH_DEPTH = 64u;
const BVH_FAR = 3.0e38;

// t: the distance along dir (in units of its length); triangle: its index in the mesh as given
// to buildBvh, BVH_MISS for none; u, v: barycentrics, the point is (1 - u - v) v0 + u v1 + v v2.
struct BvhHit { t: f32, triangle: u32, u: f32, v: f32 }

fn bvhInverse(d: vec3f) -> vec3f {
  return 1.0 / select(d, vec3f(1e-20), abs(d) < vec3f(1e-20));
}

// Where the ray enters node's box inside (tMin, tMax), or BVH_FAR when it misses.
fn bvhBox(o: vec3f, inv: vec3f, node: u32, tMin: f32, tMax: f32) -> f32 {
  let a = (bvhNodes[node * 2u].xyz - o) * inv;
  let b = (bvhNodes[node * 2u + 1u].xyz - o) * inv;
  let near = min(a, b);
  let far = max(a, b);
  let enter = max(max(near.x, near.y), max(near.z, tMin));
  // Widened by a few ulps, so a box no thicker than its triangles is not missed by rounding.
  let leave = min(min(far.x, far.y), min(far.z, tMax)) * 1.0000005;
  return select(BVH_FAR, enter, enter <= leave);
}

// Triangle i in leaf order: (t, u, v), t -BVH_FAR when the ray's line misses it.
fn bvhTriangle(o: vec3f, d: vec3f, i: u32) -> vec3f {
  let v0 = bvhTriangles[i * 3u].xyz;
  let e1 = bvhTriangles[i * 3u + 1u].xyz - v0;
  let e2 = bvhTriangles[i * 3u + 2u].xyz - v0;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (det == 0.0) { return vec3f(-BVH_FAR, 0.0, 0.0); }
  let f = 1.0 / det;
  let s = o - v0;
  let u = dot(s, p) * f;
  let q = cross(s, e1);
  let v = dot(d, q) * f;
  if (u < 0.0 || v < 0.0 || u + v > 1.0) { return vec3f(-BVH_FAR, 0.0, 0.0); }
  return vec3f(dot(e2, q) * f, u, v);
}

// The nearest triangle hit between tMin and tMax; triangle BVH_MISS and t tMax when there is none.
fn bvhClosest(origin: vec3f, dir: vec3f, tMin: f32, tMax: f32) -> BvhHit {
  var hit = BvhHit(tMax, BVH_MISS, 0.0, 0.0);
  let inv = bvhInverse(dir);
  if (bvhBox(origin, inv, 0u, tMin, tMax) == BVH_FAR) { return hit; }
  var stack: array<u32, BVH_DEPTH>;
  var enter: array<f32, BVH_DEPTH>;
  var top = 0u;
  var node = 0u;
  loop {
    let a = bvhNodes[node * 2u];
    let first = bitcast<u32>(a.w);
    let count = bitcast<u32>(bvhNodes[node * 2u + 1u].w);
    var next = BVH_MISS;
    if (count > 0u) {
      for (var i = first; i < first + count; i++) {
        let h = bvhTriangle(origin, dir, i);
        if (h.x > tMin && h.x < hit.t) {
          hit = BvhHit(h.x, bitcast<u32>(bvhTriangles[i * 3u].w), h.y, h.z);
        }
      }
    } else if (first > 0u) {
      // An inner node's children are never node 0: count 0 and first 0 is the empty root.
      var near = first;
      var far = first + 1u;
      var dNear = bvhBox(origin, inv, near, tMin, hit.t);
      var dFar = bvhBox(origin, inv, far, tMin, hit.t);
      if (dFar < dNear) {
        near = far;
        far = first;
        let d = dNear;
        dNear = dFar;
        dFar = d;
      }
      if (dNear < BVH_FAR) {
        next = near;
        if (dFar < BVH_FAR) {
          stack[top] = far;
          enter[top] = dFar;
          top++;
        }
      }
    }
    // The next node waiting that the ray may still reach before its hit.
    while (next == BVH_MISS && top > 0u) {
      top--;
      if (enter[top] < hit.t) { next = stack[top]; }
    }
    if (next == BVH_MISS) { break; }
    node = next;
  }
  return hit;
}

// Whether any triangle lies between tMin and tMax: a shadow ray, an occlusion test.
fn bvhAny(origin: vec3f, dir: vec3f, tMin: f32, tMax: f32) -> bool {
  let inv = bvhInverse(dir);
  if (bvhBox(origin, inv, 0u, tMin, tMax) == BVH_FAR) { return false; }
  var stack: array<u32, BVH_DEPTH>;
  var top = 0u;
  var node = 0u;
  loop {
    let first = bitcast<u32>(bvhNodes[node * 2u].w);
    let count = bitcast<u32>(bvhNodes[node * 2u + 1u].w);
    var next = BVH_MISS;
    if (count > 0u) {
      for (var i = first; i < first + count; i++) {
        let t = bvhTriangle(origin, dir, i).x;
        if (t > tMin && t < tMax) { return true; }
      }
    } else if (first > 0u) {
      let l = bvhBox(origin, inv, first, tMin, tMax) < BVH_FAR;
      let r = bvhBox(origin, inv, first + 1u, tMin, tMax) < BVH_FAR;
      if (l) { next = first; }
      if (r) {
        if (l) {
          stack[top] = first + 1u;
          top++;
        } else {
          next = first + 1u;
        }
      }
    }
    if (next == BVH_MISS) {
      if (top == 0u) { break; }
      top--;
      next = stack[top];
    }
    node = next;
  }
  return false;
}
`
