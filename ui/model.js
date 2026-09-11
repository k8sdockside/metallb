// The MetalLB model every page of this plugin draws from: the pools and the
// addresses in them, which service holds which address, how each pool is
// announced, and from where. Read once per poll through the k8sdockside bridge
// and worked out here, so the pages only have to draw.
//
// Addresses are BigInts throughout. An IPv6 pool is as ordinary as an IPv4 one
// in MetalLB, and a /64 does not fit in a double.
(function () {
    'use strict';

    var KINDS = {
        pools: 'crd:ipaddresspools.metallb.io',
        l2: 'crd:l2advertisements.metallb.io',
        bgp: 'crd:bgpadvertisements.metallb.io',
        peers: 'crd:bgppeers.metallb.io',
        l2Status: 'crd:servicel2statuses.metallb.io',
        bgpStatus: 'crd:servicebgpstatuses.metallb.io',
        services: 'services',
        nodes: 'nodes',
        pods: 'pods',
        events: 'events',
    };

    // MetalLB 0.14 moved its service annotations from metallb.universe.tf to
    // metallb.io and still reads both. Which one a cluster uses is worked out
    // from what its controller writes back -- see annotationPrefix.
    var PREFIXES = ['metallb.io/', 'metallb.universe.tf/'];

    // Nodes carrying this label are skipped by MetalLB's speakers, as by every
    // other load balancer implementation.
    var EXCLUDE_LABEL = 'node.kubernetes.io/exclude-from-external-load-balancers';

    // ----- addresses ---------------------------------------------------------

    function parseIPv4(text) {
        var parts = text.split('.');
        if (parts.length !== 4) return null;
        var n = 0n;
        for (var i = 0; i < 4; i++) {
            if (!/^\d{1,3}$/.test(parts[i])) return null;
            var octet = Number(parts[i]);
            if (octet > 255) return null;
            n = n * 256n + BigInt(octet);
        }
        return { v: 4, n: n };
    }

    function parseIPv6(text) {
        var zone = text.indexOf('%');
        if (zone >= 0) text = text.slice(0, zone);

        // A dotted quad at the end ("::ffff:10.0.0.1") is two groups.
        var lastColon = text.lastIndexOf(':');
        if (lastColon >= 0 && text.indexOf('.', lastColon) > lastColon) {
            var v4 = parseIPv4(text.slice(lastColon + 1));
            if (!v4) return null;
            var hi = Number(v4.n >> 16n).toString(16);
            var lo = Number(v4.n & 0xffffn).toString(16);
            text = text.slice(0, lastColon + 1) + hi + ':' + lo;
        }

        var halves = text.split('::');
        if (halves.length > 2) return null;
        var head = halves[0] ? halves[0].split(':') : [];
        var tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
        var missing = 8 - head.length - tail.length;
        if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

        var groups = head.concat(new Array(halves.length === 2 ? missing : 0).fill('0'), tail);
        var n = 0n;
        for (var i = 0; i < groups.length; i++) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
            n = (n << 16n) + BigInt(parseInt(groups[i], 16));
        }
        return { v: 6, n: n };
    }

    function parseIP(text) {
        text = String(text || '').trim();
        if (!text) return null;
        return text.indexOf(':') >= 0 ? parseIPv6(text) : parseIPv4(text);
    }

    function formatIP(ip) {
        if (ip.v === 4) {
            var out = [];
            for (var shift = 24n; shift >= 0n; shift -= 8n) out.push(Number((ip.n >> shift) & 255n));
            return out.join('.');
        }
        var groups = [];
        for (var s = 112n; s >= 0n; s -= 16n) groups.push(Number((ip.n >> s) & 0xffffn));
        // The longest run of two or more zero groups becomes "::".
        var best = -1;
        var bestLen = 1;
        for (var i = 0; i < 8; ) {
            if (groups[i] !== 0) {
                i++;
                continue;
            }
            var j = i;
            while (j < 8 && groups[j] === 0) j++;
            if (j - i > bestLen) {
                best = i;
                bestLen = j - i;
            }
            i = j;
        }
        var hex = groups.map(function (g) {
            return g.toString(16);
        });
        if (best < 0) return hex.join(':');
        return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLen).join(':');
    }

    function ipKey(ip) {
        return ip.v + ':' + ip.n.toString(16);
    }

    function canonical(text) {
        var ip = parseIP(text);
        return ip ? formatIP(ip) : String(text || '');
    }

    // One entry of an IPAddressPool's spec.addresses: a CIDR, a "from-to"
    // range, or a single address.
    function parseRange(text) {
        text = String(text || '').trim();
        var range = { text: text, v: 0, start: 0n, end: 0n, size: 0n, error: '' };
        var start, end;

        if (text.indexOf('/') >= 0) {
            var cut = text.split('/');
            var base = parseIP(cut[0]);
            var bits = Number(cut[1]);
            var width = base && base.v === 4 ? 32 : 128;
            if (!base || !/^\d{1,3}$/.test(cut[1]) || bits > width) {
                range.error = 'not a CIDR';
                return range;
            }
            var host = BigInt(width - bits);
            start = { v: base.v, n: (base.n >> host) << host };
            end = { v: base.v, n: start.n + (1n << host) - 1n };
        } else if (text.indexOf('-') >= 0) {
            var pair = text.split('-');
            start = parseIP(pair[0]);
            end = parseIP(pair[1]);
            if (pair.length !== 2 || !start || !end || start.v !== end.v || end.n < start.n) {
                range.error = 'not a range';
                return range;
            }
        } else {
            start = end = parseIP(text);
            if (!start) {
                range.error = 'not an address';
                return range;
            }
        }
        range.v = start.v;
        range.start = start.n;
        range.end = end.n;
        range.size = end.n - start.n + 1n;
        return range;
    }

    function inRange(range, ip) {
        return !range.error && range.v === ip.v && ip.n >= range.start && ip.n <= range.end;
    }

    // avoidBuggyIPs keeps MetalLB off IPv4 addresses ending in .0 and .255,
    // which some old consumer gear drops as broadcast.
    function isBuggy(ip) {
        if (ip.v !== 4) return false;
        var last = ip.n % 256n;
        return last === 0n || last === 255n;
    }

    function floorDiv(a, b) {
        return a >= 0n ? a / b : -((-a + b - 1n) / b);
    }

    // How many addresses in [start, end] leave `rest` when divided by 256.
    function countResidue(start, end, rest) {
        return floorDiv(end - rest, 256n) - floorDiv(start - 1n - rest, 256n);
    }

    function buggyIn(range) {
        if (range.error || range.v !== 4) return 0n;
        return countResidue(range.start, range.end, 0n) + countResidue(range.start, range.end, 255n);
    }

    // ----- small readers -----------------------------------------------------

    function dig(obj, path) {
        var at = obj;
        var keys = path.split('.');
        for (var i = 0; i < keys.length; i++) {
            if (at === null || at === undefined) return undefined;
            at = at[keys[i]];
        }
        return at;
    }

    function keyOf(obj) {
        return (obj.metadata.namespace || '') + '/' + obj.metadata.name;
    }

    function labelsOf(obj) {
        return (obj && obj.metadata && obj.metadata.labels) || {};
    }

    function annotation(svc, name) {
        var all = (svc.metadata && svc.metadata.annotations) || {};
        for (var i = 0; i < PREFIXES.length; i++) {
            if (all[PREFIXES[i] + name] !== undefined) return all[PREFIXES[i] + name];
        }
        return '';
    }

    function conditionTrue(obj, type) {
        var list = dig(obj, 'status.conditions') || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].type === type) return list[i].status === 'True';
        }
        return false;
    }

    // A Kubernetes LabelSelector against a set of labels. An empty selector
    // selects everything, as it does in the API.
    function selects(selector, labels) {
        if (!selector) return true;
        labels = labels || {};
        var match = selector.matchLabels || {};
        for (var key in match) {
            if (labels[key] !== match[key]) return false;
        }
        var expressions = selector.matchExpressions || [];
        for (var i = 0; i < expressions.length; i++) {
            var e = expressions[i];
            var has = Object.prototype.hasOwnProperty.call(labels, e.key);
            var values = e.values || [];
            switch (e.operator) {
                case 'In':
                    if (!has || values.indexOf(labels[e.key]) < 0) return false;
                    break;
                case 'NotIn':
                    if (has && values.indexOf(labels[e.key]) >= 0) return false;
                    break;
                case 'Exists':
                    if (!has) return false;
                    break;
                case 'DoesNotExist':
                    if (has) return false;
                    break;
                default:
                    return false;
            }
        }
        return true;
    }

    function selectsAny(selectors, labels) {
        if (!selectors || selectors.length === 0) return true;
        return selectors.some(function (s) {
            return selects(s, labels);
        });
    }

    // ----- building the model ------------------------------------------------

    function buildPool(obj) {
        var spec = obj.spec || {};
        var ranges = (spec.addresses || []).map(parseRange);
        var avoidBuggy = spec.avoidBuggyIPs === true;
        var capacity = 0n;
        ranges.forEach(function (r) {
            if (r.error) return;
            capacity += r.size;
            if (avoidBuggy) capacity -= buggyIn(r);
        });
        var alloc = spec.serviceAllocation || null;
        return {
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            labels: labelsOf(obj),
            ranges: ranges,
            capacity: capacity,
            autoAssign: spec.autoAssign !== false,
            avoidBuggy: avoidBuggy,
            priority: alloc && alloc.priority !== undefined ? alloc.priority : null,
            onlyNamespaces: (alloc && alloc.namespaces) || [],
            namespaceSelectors: (alloc && alloc.namespaceSelectors) || [],
            serviceSelectors: (alloc && alloc.serviceSelectors) || [],
            families: ranges
                .filter(function (r) {
                    return !r.error;
                })
                .map(function (r) {
                    return r.v;
                }),
            used: 0,
            l2: [],
            bgp: [],
        };
    }

    function contains(pool, ip) {
        return pool.ranges.some(function (r) {
            return inRange(r, ip);
        });
    }

    function buildService(obj) {
        var spec = obj.spec || {};
        var ingress = dig(obj, 'status.loadBalancer.ingress') || [];
        var requested = String(annotation(obj, 'loadBalancerIPs') || spec.loadBalancerIP || '')
            .split(',')
            .map(function (s) {
                return s.trim();
            })
            .filter(Boolean);
        return {
            key: keyOf(obj),
            name: obj.metadata.name,
            namespace: obj.metadata.namespace || '',
            obj: obj,
            type: spec.type || 'ClusterIP',
            lbClass: spec.loadBalancerClass || '',
            ips: ingress
                .map(function (i) {
                    return i.ip;
                })
                .filter(Boolean)
                .map(canonical),
            hostnames: ingress
                .map(function (i) {
                    return i.hostname;
                })
                .filter(Boolean),
            requestedPool: annotation(obj, 'address-pool'),
            requestedIPs: requested,
            shareKey: annotation(obj, 'allow-shared-ip'),
            allocatedFrom: annotation(obj, 'ip-allocated-from-pool'),
            families: spec.ipFamilies || [],
            localTraffic: spec.externalTrafficPolicy === 'Local',
            ports: (spec.ports || []).map(function (p) {
                return p.port + '/' + (p.protocol || 'TCP');
            }),
        };
    }

    function isSpeaker(pod) {
        var l = labelsOf(pod);
        return l['app.kubernetes.io/component'] === 'speaker' || l.component === 'speaker';
    }

    function isController(pod) {
        var l = labelsOf(pod);
        return l['app.kubernetes.io/component'] === 'controller' || l.component === 'controller';
    }

    function podReady(pod) {
        return dig(pod, 'status.phase') === 'Running' && conditionTrue(pod, 'Ready');
    }

    // "quay.io/metallb/controller:v0.14.8" -> "v0.14.8".
    function versionOf(pod) {
        var containers = dig(pod, 'spec.containers') || [];
        for (var i = 0; i < containers.length; i++) {
            var image = containers[i].image || '';
            var at = image.lastIndexOf(':');
            if (at > image.lastIndexOf('/') && image.indexOf('metallb') >= 0) return image.slice(at + 1);
        }
        return '';
    }

    // Which annotation prefix this cluster's MetalLB answers to: the one its
    // controller writes back on the services it has served.
    function annotationPrefix(services) {
        var modern = false;
        var legacy = false;
        services.forEach(function (s) {
            var all = s.obj.metadata.annotations || {};
            if (all['metallb.io/ip-allocated-from-pool'] !== undefined) modern = true;
            if (all['metallb.universe.tf/ip-allocated-from-pool'] !== undefined) legacy = true;
        });
        return legacy && !modern ? 'metallb.universe.tf/' : 'metallb.io/';
    }

    // Who a status object is about. The status fields came first; the labels
    // are what newer releases also set, and the selector-friendly copy.
    function statusTarget(obj) {
        var l = labelsOf(obj);
        var status = obj.status || {};
        return {
            key: (status.serviceNamespace || l['metallb.io/service-namespace'] || '') + '/' + (status.serviceName || l['metallb.io/service-name'] || ''),
            node: status.node || l['metallb.io/node'] || '',
            interfaces: (status.interfaces || []).map(function (i) {
                return i.name;
            }),
            peers: status.peers || [],
        };
    }

    function soft(promise) {
        return promise.then(
            function (items) {
                return { ok: true, items: items || [], error: '' };
            },
            function (err) {
                return { ok: false, items: [], error: (err && err.message) || String(err) };
            },
        );
    }

    function version(list) {
        return list
            .map(function (o) {
                return o.metadata.uid + '@' + o.metadata.resourceVersion;
            })
            .join(',');
    }

    // Reads everything the pages need. Only the pools are required: a cluster
    // without the newer status kinds, or where speaker pods carry other labels,
    // still gets everything else.
    function load(sdk) {
        function list(kind, namespace, selector) {
            return soft(sdk.list({ kind: kind, namespace: namespace || '', selector: selector || '' }));
        }
        return Promise.all([
            list(KINDS.pools),
            list(KINDS.l2),
            list(KINDS.bgp),
            list(KINDS.peers),
            list(KINDS.l2Status),
            list(KINDS.bgpStatus),
            list(KINDS.services),
            list(KINDS.nodes),
            // The Helm chart and the plain manifests label MetalLB differently.
            list(KINDS.pods, '', 'app.kubernetes.io/name=metallb'),
            list(KINDS.pods, '', 'app=metallb'),
        ]).then(function (got) {
            var model = build({
                pools: got[0],
                l2: got[1],
                bgp: got[2],
                peers: got[3],
                l2Status: got[4],
                bgpStatus: got[5],
                services: got[6],
                nodes: got[7],
                pods: { ok: true, items: dedupe(got[8].items.concat(got[9].items)) },
            });
            return withEvents(sdk, model);
        });
    }

    function dedupe(list) {
        var seen = {};
        return list.filter(function (o) {
            if (seen[o.metadata.uid]) return false;
            seen[o.metadata.uid] = true;
            return true;
        });
    }

    // The newest warning MetalLB left on each service still waiting for an
    // address: usually the plainest statement of why.
    function withEvents(sdk, model) {
        if (model.pending.length === 0) return model;
        var namespaces = {};
        model.pending.forEach(function (s) {
            namespaces[s.namespace] = true;
        });
        return Promise.all(
            Object.keys(namespaces).map(function (ns) {
                return soft(sdk.list({ kind: KINDS.events, namespace: ns }));
            }),
        ).then(function (answers) {
            var latest = {};
            answers.forEach(function (answer) {
                answer.items.forEach(function (ev) {
                    var target = ev.involvedObject || ev.regarding || {};
                    if (target.kind !== 'Service' || ev.type !== 'Warning') return;
                    var key = (target.namespace || ev.metadata.namespace) + '/' + target.name;
                    var when = ev.lastTimestamp || ev.eventTime || ev.metadata.creationTimestamp || '';
                    if (!latest[key] || latest[key].when < when) {
                        latest[key] = { when: when, reason: ev.reason || '', message: ev.message || ev.note || '' };
                    }
                });
            });
            model.pending.forEach(function (s) {
                s.event = latest[s.key] || null;
                s.diagnosis = diagnose(s, model);
            });
            model.sig +=
                '|' +
                Object.keys(latest)
                    .map(function (k) {
                        return k + latest[k].when;
                    })
                    .join(',');
            return model;
        });
    }

    function build(raw) {
        var model = {
            installed: raw.pools.ok,
            missing: raw.pools.error,
            kinds: {
                l2: raw.l2.ok,
                bgp: raw.bgp.ok,
                peers: raw.peers.ok,
                l2Status: raw.l2Status.ok,
                bgpStatus: raw.bgpStatus.ok,
            },
            pools: [],
            l2: raw.l2.items,
            bgp: raw.bgp.items,
            peers: raw.peers.items,
            nodes: [],
            services: [],
            pending: [],
            allocations: new Map(),
            speakers: [],
            controller: null,
            version: '',
            namespace: '',
            prefix: 'metallb.io/',
            colors: {},
            findings: [],
            l2Status: {},
            bgpStatus: {},
            sig: '',
        };

        model.sig = [raw.pools, raw.l2, raw.bgp, raw.peers, raw.l2Status, raw.bgpStatus, raw.pods, raw.nodes]
            .map(function (r) {
                return version(r.items);
            })
            .join('|');

        model.pools = raw.pools.items
            .map(buildPool)
            .sort(function (a, b) {
                return a.name.localeCompare(b.name);
            });

        // ----- speakers and nodes

        raw.pods.items.forEach(function (pod) {
            if (isSpeaker(pod)) model.speakers.push(pod);
            else if (isController(pod)) model.controller = model.controller || pod;
        });
        var anchor = model.controller || model.speakers[0];
        if (anchor) {
            model.version = versionOf(anchor);
            model.namespace = anchor.metadata.namespace;
        }
        var speakerOn = {};
        model.speakers.forEach(function (pod) {
            var node = dig(pod, 'spec.nodeName');
            if (node) speakerOn[node] = pod;
        });
        model.nodes = raw.nodes.items
            .map(function (n) {
                var speaker = speakerOn[n.metadata.name] || null;
                return {
                    name: n.metadata.name,
                    obj: n,
                    labels: labelsOf(n),
                    ready: conditionTrue(n, 'Ready'),
                    excluded: labelsOf(n)[EXCLUDE_LABEL] !== undefined,
                    speaker: speaker,
                    speakerReady: !!speaker && podReady(speaker),
                    announces: 0,
                };
            })
            .sort(function (a, b) {
                return a.name.localeCompare(b.name);
            });
        model.speakersKnown = model.speakers.length > 0;

        // ----- advertisements

        function wirePools(adv, into) {
            var names = dig(adv, 'spec.ipAddressPools') || [];
            var selectors = dig(adv, 'spec.ipAddressPoolSelectors') || [];
            var all = names.length === 0 && selectors.length === 0;
            var pools = model.pools.filter(function (p) {
                return all || names.indexOf(p.name) >= 0 || selectors.some(function (s) {
                    return selects(s, p.labels);
                });
            });
            pools.forEach(function (p) {
                p[into].push(adv.metadata.name);
            });
            return pools;
        }

        function eligibleNodes(selectors) {
            return model.nodes.filter(function (n) {
                return !n.excluded && selectsAny(selectors, n.labels);
            });
        }

        model.advertisements = [];
        model.l2.forEach(function (adv) {
            model.advertisements.push({
                mode: 'l2',
                name: adv.metadata.name,
                obj: adv,
                pools: wirePools(adv, 'l2'),
                nodes: eligibleNodes(dig(adv, 'spec.nodeSelectors')),
                interfaces: dig(adv, 'spec.interfaces') || [],
                peers: [],
            });
        });

        model.peerList = model.peers.map(function (p) {
            var spec = p.spec || {};
            return {
                name: p.metadata.name,
                obj: p,
                address: spec.peerAddress || '',
                port: spec.peerPort || 179,
                myASN: spec.myASN,
                peerASN: spec.peerASN,
                bfd: spec.bfdProfile || '',
                nodes: eligibleNodes(spec.nodeSelectors),
            };
        });

        model.bgp.forEach(function (adv) {
            var names = dig(adv, 'spec.peers') || [];
            model.advertisements.push({
                mode: 'bgp',
                name: adv.metadata.name,
                obj: adv,
                pools: wirePools(adv, 'bgp'),
                nodes: eligibleNodes(dig(adv, 'spec.nodeSelectors')),
                interfaces: [],
                peers: model.peerList.filter(function (p) {
                    return names.length === 0 || names.indexOf(p.name) >= 0;
                }),
                aggregation: dig(adv, 'spec.aggregationLength'),
                communities: dig(adv, 'spec.communities') || [],
                localPref: dig(adv, 'spec.localPref'),
            });
        });

        // ----- who is announcing what, where MetalLB says

        raw.l2Status.items.forEach(function (s) {
            var t = statusTarget(s);
            (model.l2Status[t.key] = model.l2Status[t.key] || []).push(t);
        });
        raw.bgpStatus.items.forEach(function (s) {
            var t = statusTarget(s);
            (model.bgpStatus[t.key] = model.bgpStatus[t.key] || []).push(t);
        });

        // ----- services and the addresses they hold

        var lb = raw.services.items
            .filter(function (s) {
                return dig(s, 'spec.type') === 'LoadBalancer';
            })
            .map(buildService);
        model.services = lb;
        model.sig += '|' + version(lb.map(function (s) {
            return s.obj;
        }));
        model.prefix = annotationPrefix(lb);

        function poolNamed(name) {
            for (var i = 0; i < model.pools.length; i++) if (model.pools[i].name === name) return model.pools[i];
            return null;
        }
        model.poolNamed = poolNamed;

        lb.forEach(function (svc) {
            svc.pools = [];
            svc.ips.forEach(function (text) {
                var ip = parseIP(text);
                if (!ip) return;
                var pool = poolNamed(svc.allocatedFrom);
                if (!pool || !contains(pool, ip)) {
                    pool = null;
                    for (var i = 0; i < model.pools.length; i++) {
                        if (contains(model.pools[i], ip)) {
                            pool = model.pools[i];
                            break;
                        }
                    }
                }
                if (!pool) return;
                var key = ipKey(ip);
                var at = model.allocations.get(key);
                if (!at) {
                    at = { key: key, ip: ip, text: formatIP(ip), pool: pool, services: [] };
                    model.allocations.set(key, at);
                    pool.used++;
                }
                at.services.push(svc);
                if (svc.pools.indexOf(pool) < 0) svc.pools.push(pool);
            });
            // Waiting: no address yet, and not something another load
            // balancer has visibly taken.
            if (svc.ips.length === 0 && svc.hostnames.length === 0) model.pending.push(svc);
        });

        // Announcing counts per node, from the status objects.
        Object.keys(model.l2Status).forEach(function (key) {
            model.l2Status[key].forEach(function (t) {
                var node = model.nodes.find(function (n) {
                    return n.name === t.node;
                });
                if (node) node.announces++;
            });
        });

        // ----- colours: one per namespace, busiest first

        var perNamespace = {};
        model.allocations.forEach(function (at) {
            at.services.forEach(function (s) {
                perNamespace[s.namespace] = (perNamespace[s.namespace] || 0) + 1;
            });
        });
        Object.keys(perNamespace)
            .sort(function (a, b) {
                return perNamespace[b] - perNamespace[a] || a.localeCompare(b);
            })
            .forEach(function (ns, i) {
                model.colors[ns] = 'var(--chart-' + Math.min(i + 1, 8) + ', ' + FALLBACK_CHART[Math.min(i, 7)] + ')';
            });

        model.pending.forEach(function (s) {
            s.diagnosis = diagnose(s, model);
        });
        model.findings = findings(model);
        return model;
    }

    var FALLBACK_CHART = ['#4c8dff', '#3ecf8e', '#f5b83d', '#c77dff', '#ff7a90', '#2ec4d6', '#e8864a', '#8c96a8'];

    // ----- reading the model -------------------------------------------------

    // Could this pool give an address to this service, as far as can be told
    // from here? Namespace selectors need the namespace's labels, which this
    // plugin does not read, so a pool narrowed only by those is given the
    // benefit of the doubt.
    function poolServes(pool, svc) {
        if (pool.onlyNamespaces.length > 0 && pool.namespaceSelectors.length === 0 && pool.onlyNamespaces.indexOf(svc.namespace) < 0) {
            return false;
        }
        if (pool.serviceSelectors.length > 0 && !selectsAny(pool.serviceSelectors, labelsOf(svc.obj))) return false;
        return true;
    }

    function free(pool) {
        var left = pool.capacity - BigInt(pool.used);
        return left > 0n ? left : 0n;
    }

    // A sentence on why a LoadBalancer service has no address, most specific
    // first, and the tone to draw it in.
    function diagnose(svc, model) {
        var mine = svc.lbClass === '' || svc.lbClass.indexOf('metallb') >= 0;
        if (!mine) {
            return { tone: 'info', text: 'It asks for load balancer class "' + svc.lbClass + '". MetalLB only serves it if it was started with that class.' };
        }
        if (model.pools.length === 0) {
            return { tone: 'error', text: 'There is no IPAddressPool, so MetalLB has nothing to hand out.' };
        }
        if (svc.requestedPool && !model.poolNamed(svc.requestedPool)) {
            return { tone: 'error', text: 'It asks for pool "' + svc.requestedPool + '", which does not exist.' };
        }
        for (var i = 0; i < svc.requestedIPs.length; i++) {
            var ip = parseIP(svc.requestedIPs[i]);
            if (!ip) return { tone: 'error', text: '"' + svc.requestedIPs[i] + '" is not an IP address.' };
            var holder = model.allocations.get(ipKey(ip));
            if (holder && holder.services.length > 0) {
                var other = holder.services[0];
                var shared = svc.shareKey && svc.shareKey === other.shareKey;
                if (!shared) {
                    return { tone: 'error', text: 'It asks for ' + formatIP(ip) + ', which ' + other.namespace + '/' + other.name + ' already holds. Give both the same allow-shared-ip key to share it.' };
                }
            }
            var owner = model.pools.find(function (p) {
                return contains(p, ip);
            });
            if (!owner) return { tone: 'error', text: 'It asks for ' + formatIP(ip) + ', which is in no pool.' };
        }

        var candidates = svc.requestedPool
            ? [model.poolNamed(svc.requestedPool)]
            : model.pools.filter(function (p) {
                  return p.autoAssign;
              });
        if (candidates.length === 0) {
            return { tone: 'warn', text: 'No pool hands out addresses by itself — every one has auto-assign off. Pick a pool for it.' };
        }
        var allowed = candidates.filter(function (p) {
            return poolServes(p, svc);
        });
        if (allowed.length === 0) {
            return { tone: 'warn', text: 'The pools it could use are reserved for other namespaces or services.' };
        }
        var wantsV6 = svc.families.indexOf('IPv6') >= 0;
        var wantsV4 = svc.families.length === 0 || svc.families.indexOf('IPv4') >= 0;
        var family = allowed.filter(function (p) {
            return (!wantsV4 || p.families.indexOf(4) >= 0) && (!wantsV6 || p.families.indexOf(6) >= 0);
        });
        if (family.length === 0) {
            return { tone: 'warn', text: 'It wants ' + (wantsV6 && wantsV4 ? 'both IPv4 and IPv6' : wantsV6 ? 'IPv6' : 'IPv4') + ', and no pool it can use has that.' };
        }
        if (
            family.every(function (p) {
                return free(p) === 0n;
            })
        ) {
            return { tone: 'error', text: 'Every pool it could use is full.' };
        }
        if (svc.event && svc.event.message) {
            return { tone: 'warn', text: svc.event.message, reason: svc.event.reason };
        }
        return { tone: 'info', text: 'MetalLB has not given it an address yet. If this lasts, the controller may not be running.' };
    }

    // What is wrong with the setup as a whole, worst first.
    function findings(model) {
        var out = [];
        if (!model.installed) return out;
        if (model.pools.length === 0) {
            out.push({ tone: 'warn', text: 'There are no IPAddressPools. MetalLB is installed, but has no addresses to give out.' });
        }
        model.pools.forEach(function (p) {
            if (p.l2.length === 0 && p.bgp.length === 0) {
                out.push({
                    tone: p.used > 0 ? 'error' : 'warn',
                    text: 'Pool "' + p.name + '" is not advertised. ' + (p.used > 0 ? p.used + ' address' + (p.used === 1 ? ' is' : 'es are') + ' handed out from it, but nothing outside the cluster is told where to find ' + (p.used === 1 ? 'it' : 'them') + '.' : 'Add an L2Advertisement or BGPAdvertisement for it.'),
                    ref: { kind: KINDS.pools, namespace: p.namespace, name: p.name },
                });
            }
            p.ranges.forEach(function (r) {
                if (r.error) out.push({ tone: 'error', text: 'Pool "' + p.name + '" has "' + r.text + '", which is ' + r.error + '.' });
            });
            if (p.capacity > 0n && free(p) === 0n) {
                out.push({ tone: 'warn', text: 'Pool "' + p.name + '" is full. The next service that needs it will wait.' });
            }
        });
        if (model.speakersKnown) {
            var down = model.nodes.filter(function (n) {
                return n.speaker && !n.speakerReady;
            });
            if (down.length > 0) {
                out.push({ tone: 'error', text: 'The speaker is not ready on ' + names(down) + '. Addresses announced from ' + (down.length === 1 ? 'that node' : 'those nodes') + ' may be unreachable.' });
            }
        }
        model.advertisements.forEach(function (a) {
            if (a.pools.length === 0) {
                out.push({ tone: 'warn', text: (a.mode === 'l2' ? 'L2' : 'BGP') + 'Advertisement "' + a.name + '" selects no pool.', ref: { kind: a.mode === 'l2' ? KINDS.l2 : KINDS.bgp, namespace: a.obj.metadata.namespace, name: a.name } });
            }
            if (a.nodes.length === 0 && model.nodes.length > 0) {
                out.push({ tone: 'warn', text: (a.mode === 'l2' ? 'L2' : 'BGP') + 'Advertisement "' + a.name + '" selects no node, so nothing announces it.', ref: { kind: a.mode === 'l2' ? KINDS.l2 : KINDS.bgp, namespace: a.obj.metadata.namespace, name: a.name } });
            } else if (
                model.speakersKnown &&
                a.nodes.length > 0 &&
                !a.nodes.some(function (n) {
                    return n.speakerReady;
                })
            ) {
                out.push({
                    tone: 'error',
                    text: (a.mode === 'l2' ? 'L2' : 'BGP') + 'Advertisement "' + a.name + '" only selects ' + names(a.nodes) + ', where no speaker is ready — nothing is announcing ' + (a.pools.length === 1 ? 'pool "' + a.pools[0].name + '"' : 'its pools') + ' through it.',
                    ref: { kind: a.mode === 'l2' ? KINDS.l2 : KINDS.bgp, namespace: a.obj.metadata.namespace, name: a.name },
                });
            }
            if (a.mode === 'bgp' && a.peers.length === 0) {
                out.push({ tone: 'warn', text: 'BGPAdvertisement "' + a.name + '" has no BGPPeer to announce to.' });
            }
        });
        var excluded = model.nodes.filter(function (n) {
            return n.excluded;
        });
        if (excluded.length > 0) {
            out.push({ tone: 'info', text: names(excluded) + (excluded.length === 1 ? ' is' : ' are') + ' labelled ' + EXCLUDE_LABEL + ', so MetalLB never announces from ' + (excluded.length === 1 ? 'it' : 'them') + '.' });
        }
        var rank = { error: 0, warn: 1, info: 2 };
        return out.sort(function (a, b) {
            return rank[a.tone] - rank[b.tone];
        });
    }

    function names(list) {
        var shown = list.slice(0, 3).map(function (n) {
            return n.name;
        });
        if (list.length > 3) shown.push(list.length - 3 + ' more');
        return shown.join(', ');
    }

    // How an address held by a service reaches the outside: the pool, each
    // advertisement over it, and the nodes and peers that carry it -- from
    // MetalLB's own status objects where it wrote them, else from what the
    // configuration allows.
    function route(model, svc, pool) {
        var hops = [];
        model.advertisements.forEach(function (adv) {
            if (adv.pools.indexOf(pool) < 0) return;
            var hop = { mode: adv.mode, adv: adv, nodes: [], peers: [], known: false, candidates: [] };
            // A speaker that is not ready is not in the running: it cannot
            // answer, and MetalLB elects among the live ones.
            var eligible = adv.nodes.filter(function (n) {
                return !model.speakersKnown || n.speakerReady;
            });
            hop.candidates = eligible;
            if (adv.mode === 'l2') {
                var seen = model.l2Status[svc.key] || [];
                if (seen.length > 0) {
                    hop.known = true;
                    hop.nodes = seen.map(function (t) {
                        return { name: t.node, interfaces: t.interfaces };
                    });
                }
            } else {
                var told = model.bgpStatus[svc.key] || [];
                hop.peers = adv.peers;
                if (told.length > 0) {
                    hop.known = true;
                    hop.nodes = told.map(function (t) {
                        return { name: t.node, peers: t.peers };
                    });
                }
            }
            hops.push(hop);
        });
        return hops;
    }

    // A BigInt count written for a person: exact while it is small enough to
    // read, a power of two once it is not.
    function count(big) {
        if (big < 1000000n) return Number(big).toLocaleString();
        var bits = big.toString(2).length - 1;
        return big === 1n << BigInt(bits) ? '2^' + bits : '≈ 2^' + bits;
    }

    function share(used, capacity) {
        if (capacity === 0n) return 0;
        if (capacity > 1000000000n) return used > 0 ? 0.0001 : 0;
        return Math.min(1, used / Number(capacity));
    }

    function percent(fraction) {
        if (fraction === 0) return '0%';
        if (fraction < 0.01) return '<1%';
        return Math.round(fraction * 100) + '%';
    }

    window.MetalLB = {
        KINDS: KINDS,
        EXCLUDE_LABEL: EXCLUDE_LABEL,
        load: load,
        parseIP: parseIP,
        formatIP: formatIP,
        ipKey: ipKey,
        parseRange: parseRange,
        inRange: inRange,
        isBuggy: isBuggy,
        contains: contains,
        free: free,
        route: route,
        diagnose: diagnose,
        poolServes: poolServes,
        count: count,
        share: share,
        percent: percent,
        dig: dig,
        podReady: podReady,
        buildService: buildService,
    };
})();
