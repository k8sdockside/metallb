// The drawing kit the pages share: icons, gauges, the seat map of a pool's
// addresses, the route an address takes out of the cluster, and the patches
// the fix-it controls ask the app to make.
//
// Everything that came from the cluster is written with textContent, never
// innerHTML: the frame is sandboxed, but a page that let a service's name run
// as markup would be handing that name the bridge.
(function () {
    'use strict';

    var M = window.MetalLB;
    var SVG = 'http://www.w3.org/2000/svg';

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function add(parent) {
        for (var i = 1; i < arguments.length; i++) {
            var child = arguments[i];
            if (child === null || child === undefined || child === false) continue;
            parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return parent;
    }

    function svg(tag, attrs) {
        var node = document.createElementNS(SVG, tag);
        Object.keys(attrs || {}).forEach(function (k) {
            node.setAttribute(k, attrs[k]);
        });
        return node;
    }

    // Single-stroke icons on a 24-unit grid.
    var ICONS = {
        pool: ['M4 6.5C4 5 7.6 4 12 4s8 1 8 2.5S16.4 9 12 9 4 8 4 6.5z', 'M4 6.5v5C4 13 7.6 14 12 14s8-1 8-2.5v-5', 'M4 11.5v5C4 18 7.6 19 12 19s8-1 8-2.5v-5'],
        l2: ['M12 18.5h.01', 'M8.5 15a5 5 0 0 1 7 0', 'M5.5 12a9 9 0 0 1 13 0', 'M2.5 9a13 13 0 0 1 19 0'],
        bgp: ['M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M7 17h4a4 4 0 0 0 4-4v-2a4 4 0 0 1 2-3.4'],
        node: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'],
        peer: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
        service: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
        pin: ['M12 21s-6-5.3-6-11a6 6 0 1 1 12 0c0 5.7-6 11-6 11z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
        alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
        check: ['M4 12.5l5 5L20 6.5'],
        info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5h.01'],
        search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
        arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
        edit: ['M4 20h4L19 9l-4-4L4 16z', 'M14 6l4 4'],
        open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
        share: ['M8 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M22 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M22 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M7.7 10.7l8.6-3.4', 'M7.7 13.3l8.6 3.4'],
        spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M6 6l2.5 2.5', 'M15.5 15.5L18 18', 'M6 18l2.5-2.5', 'M15.5 8.5L18 6'],
        activity: ['M3 12h4l3-8 4 16 3-8h4'],
        clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
        chart: ['M4 4v16h16', 'M8 15l3-4 3 2 5-6'],
        grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
        close: ['M6 6l12 12', 'M18 6L6 18'],
        logo: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v10', 'M12 12l-5 3', 'M12 12l5 3', 'M12 7h.01'],
    };

    function icon(name, className) {
        var node = svg('svg', { viewBox: '0 0 24 24', class: 'ico' + (className ? ' ' + className : ''), 'aria-hidden': 'true' });
        (ICONS[name] || ICONS.info).forEach(function (d) {
            node.appendChild(svg('path', { d: d }));
        });
        return node;
    }

    function chip(text, tone, iconName, title) {
        var node = el('span', 'chip' + (tone ? ' ' + tone : ''));
        if (iconName) node.appendChild(icon(iconName));
        node.appendChild(el('span', '', text));
        if (title) node.title = title;
        return node;
    }

    function button(text, className, iconName, onClick) {
        var node = el('button', className || '');
        node.type = 'button';
        if (iconName) node.appendChild(icon(iconName));
        if (text) node.appendChild(el('span', '', text));
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function link(text, onClick, title) {
        var node = el('button', 'link', text);
        node.type = 'button';
        if (title) node.title = title;
        node.addEventListener('click', onClick);
        return node;
    }

    // What the plugin is about, from its manifest's links: a row of links,
    // each opened in the user's browser. Null when the app did not say (an
    // app older than the links) or the manifest has none.
    function about(sdk, plugin, onError) {
        if (!plugin || !plugin.links || !plugin.links.length) return null;
        var row = el('div', 'about');
        row.appendChild(el('span', 'about-label', plugin.version ? 'Plugin ' + plugin.version + ' ·' : 'About'));
        plugin.links.forEach(function (l) {
            row.appendChild(
                link(
                    l.label,
                    function () {
                        sdk.openUrl(l.url).catch(onError || function () {});
                    },
                    l.url,
                ),
            );
        });
        return row;
    }

    // A ring gauge: the share used, drawn round from twelve o'clock.
    function ring(fraction, size, tone, label) {
        var r = size / 2 - 5;
        var c = 2 * Math.PI * r;
        var node = svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'ring ' + (tone || ''), width: size, height: size, role: 'img' });
        node.setAttribute('aria-label', label || Math.round(fraction * 100) + '%');
        node.appendChild(svg('circle', { cx: size / 2, cy: size / 2, r: r, class: 'track' }));
        var arc = svg('circle', {
            cx: size / 2,
            cy: size / 2,
            r: r,
            class: 'arc',
            'stroke-dasharray': Math.max(fraction > 0 ? 2 : 0, fraction * c) + ' ' + c,
            transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
        });
        node.appendChild(arc);
        return node;
    }

    function meter(fraction, tone) {
        var node = el('div', 'meter ' + (tone || ''));
        var fill = el('i');
        fill.style.width = fraction > 0 ? Math.max(1.5, fraction * 100) + '%' : '0';
        node.appendChild(fill);
        return node;
    }

    function fillTone(fraction) {
        if (fraction >= 0.95) return 'error';
        if (fraction >= 0.8) return 'warn';
        return 'ok';
    }

    // ----- the seat map ------------------------------------------------------

    // Up to this many addresses in a range are drawn one square each; a bigger
    // range is drawn as 256 squares, each a slice of it shaded by how full.
    var ONE_EACH = 1024;
    var SLICES = 256;

    // The start of a row, written short: ".64" when the whole range sits in
    // one /24, "::a0" when it sits in one /112.
    function rowLabel(range, n) {
        var ip = { v: range.v, n: n };
        var text = M.formatIP(ip);
        if (range.v === 4 && range.start >> 8n === range.end >> 8n) return '.' + Number(n & 255n);
        if (range.v === 6 && range.start >> 16n === range.end >> 16n) return '…:' + Number(n & 0xffffn).toString(16);
        return text;
    }

    // How many seats to a row, and how big, for a map this wide: rows of 32
    // while the squares stay comfortable to hit, else rows of 16. A row of 32
    // is an eighth of a /24, so the row labels read .0, .32, .64 ...
    var LABEL_ROOM = 110;
    function fitSeats(width) {
        var usable = Math.max(0, width - LABEL_ROOM);
        var cell = Math.floor(usable / 32) - 3;
        if (cell >= 11) return { cols: 32, cell: Math.min(18, cell) };
        return { cols: 16, cell: Math.max(10, Math.min(18, Math.floor(usable / 16) - 3)) };
    }

    // opts: { cols, cell, selected, hits (Set of keys) or null }
    function seatMap(pool, model, opts) {
        var wrap = el('div', 'seats');
        var cols = opts.cols || 32;
        pool.ranges.forEach(function (range) {
            var block = el('div', 'range');
            var head = el('div', 'range-head');
            add(head, el('code', '', range.text));
            if (range.error) {
                add(head, chip(range.error, 'error', 'alert'));
                block.appendChild(head);
                wrap.appendChild(block);
                return;
            }
            add(head, el('span', 'faint', M.count(range.size) + (range.size === 1n ? ' address' : ' addresses')));
            block.appendChild(head);

            var grid = el('div', 'grid');
            grid.style.setProperty('--cols', String(cols));
            if (opts.cell) grid.style.setProperty('--cell', opts.cell + 'px');
            if (opts.hits) grid.classList.add('searching');

            // The label column is as wide as its longest label, so a full
            // address is never cut to "172.1…".
            var widest = 0;
            function newRow(n) {
                var text = rowLabel(range, n);
                widest = Math.max(widest, text.length);
                grid.appendChild(el('span', 'row-label', text));
            }

            if (range.size <= BigInt(ONE_EACH)) {
                var i = 0;
                for (var n = range.start; n <= range.end; n++, i++) {
                    if (i % cols === 0) newRow(n);
                    var ip = { v: range.v, n: n };
                    var key = M.ipKey(ip);
                    var at = model.allocations.get(key);
                    var cell = el('i', 'seat');
                    cell.dataset.key = key;
                    if (at) {
                        var first = at.services[0];
                        cell.classList.add('used');
                        cell.style.setProperty('--c', model.colors[first.namespace] || 'var(--accent)');
                        if (at.services.length > 1) cell.classList.add('shared');
                        if (
                            at.services.some(function (s) {
                                return s.requestedIPs.length > 0;
                            })
                        ) {
                            cell.classList.add('pinned');
                        }
                    } else if (pool.avoidBuggy && M.isBuggy(ip)) {
                        cell.classList.add('buggy');
                    }
                    if (opts.selected === key) cell.classList.add('sel');
                    if (opts.hits && opts.hits.has(key)) cell.classList.add('hit');
                    grid.appendChild(cell);
                }
            } else {
                var step = (range.size + BigInt(SLICES) - 1n) / BigInt(SLICES);
                var usedIn = new Array(SLICES).fill(0);
                var hitIn = new Array(SLICES).fill(false);
                var selIn = -1;
                model.allocations.forEach(function (at) {
                    if (!M.inRange(range, at.ip)) return;
                    var slot = Number((at.ip.n - range.start) / step);
                    usedIn[slot]++;
                    if (opts.hits && opts.hits.has(at.key)) hitIn[slot] = true;
                    if (opts.selected === at.key) selIn = slot;
                });
                for (var s = 0; s < SLICES; s++) {
                    var from = range.start + BigInt(s) * step;
                    if (from > range.end) break;
                    var to = from + step - 1n;
                    if (to > range.end) to = range.end;
                    if (s % cols === 0) newRow(from);
                    var slice = el('i', 'seat slice');
                    slice.dataset.from = M.formatIP({ v: range.v, n: from });
                    slice.dataset.to = M.formatIP({ v: range.v, n: to });
                    slice.dataset.used = String(usedIn[s]);
                    slice.dataset.size = M.count(to - from + 1n);
                    if (usedIn[s] > 0) {
                        slice.classList.add('used');
                        slice.style.setProperty('--c', 'var(--accent)');
                        // Shaded by how many live there, with a floor so one
                        // address in sixteen million is still visible.
                        slice.style.setProperty('--a', String(Math.min(1, 0.45 + usedIn[s] / 16)));
                    }
                    if (hitIn[s]) slice.classList.add('hit');
                    if (selIn === s) slice.classList.add('sel');
                    grid.appendChild(slice);
                }
            }
            grid.style.setProperty('--label', widest + 'ch');
            block.appendChild(grid);
            wrap.appendChild(block);
        });
        return wrap;
    }

    function legend(pool, model) {
        var seen = {};
        model.allocations.forEach(function (at) {
            if (at.pool !== pool) return;
            at.services.forEach(function (s) {
                seen[s.namespace] = (seen[s.namespace] || 0) + 1;
            });
        });
        var names = Object.keys(seen).sort(function (a, b) {
            return seen[b] - seen[a] || a.localeCompare(b);
        });
        var node = el('div', 'legend');
        names.forEach(function (ns) {
            var item = el('span', 'key');
            var dot = el('i');
            dot.style.background = model.colors[ns];
            add(item, dot, el('span', '', ns), el('span', 'faint', String(seen[ns])));
            node.appendChild(item);
        });
        var free = el('span', 'key');
        add(free, el('i', 'free'), el('span', '', 'free'));
        node.appendChild(free);
        if (pool.avoidBuggy && pool.families.indexOf(4) >= 0) {
            var buggy = el('span', 'key');
            add(buggy, el('i', 'buggy'), el('span', '', '.0 / .255 skipped'));
            node.appendChild(buggy);
        }
        return node;
    }

    // ----- the tooltip -------------------------------------------------------

    // One floating tip for the page, filled by `describe` for whatever seat is
    // under the pointer.
    function tooltip(root, describe) {
        var tip = el('div', 'tip');
        tip.hidden = true;
        tip.setAttribute('role', 'tooltip');
        document.body.appendChild(tip);

        function place(event) {
            var pad = 14;
            var w = tip.offsetWidth;
            var h = tip.offsetHeight;
            var x = event.clientX + pad;
            var y = event.clientY + pad;
            if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
            if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
            tip.style.left = Math.max(8, x) + 'px';
            tip.style.top = Math.max(8, y) + 'px';
        }

        root.addEventListener('pointerover', function (event) {
            var seat = event.target.closest && event.target.closest('.seat');
            if (!seat) return;
            tip.textContent = '';
            if (!describe(seat, tip)) {
                tip.hidden = true;
                return;
            }
            tip.hidden = false;
            place(event);
        });
        root.addEventListener('pointermove', function (event) {
            if (!tip.hidden) place(event);
        });
        root.addEventListener('pointerout', function (event) {
            var seat = event.target.closest && event.target.closest('.seat');
            if (seat && !seat.contains(event.relatedTarget)) tip.hidden = true;
        });
        return tip;
    }

    // What the tip says about one seat.
    function describeSeat(model, pool, seat, into) {
        if (seat.classList.contains('slice')) {
            add(into, el('code', 'tip-ip', seat.dataset.from + ' – ' + seat.dataset.to));
            var used = Number(seat.dataset.used);
            add(into, el('div', 'tip-line', used === 0 ? seat.dataset.size + ' addresses, all free' : used + ' in use of ' + seat.dataset.size));
            return true;
        }
        var at = model.allocations.get(seat.dataset.key);
        var ip = at ? at.ip : keyToIP(seat.dataset.key);
        add(into, el('code', 'tip-ip', M.formatIP(ip)));
        if (at) {
            at.services.forEach(function (s) {
                var line = el('div', 'tip-line');
                var dot = el('i', 'dot');
                dot.style.background = model.colors[s.namespace];
                add(line, dot, el('strong', '', s.name), el('span', 'faint', ' · ' + s.namespace));
                into.appendChild(line);
            });
            if (at.services.length > 1) add(into, el('div', 'tip-note', 'Shared under key "' + at.services[0].shareKey + '"'));
            add(into, el('div', 'tip-note', 'Click to trace its route'));
        } else if (seat.classList.contains('buggy')) {
            add(into, el('div', 'tip-line', 'Never handed out'), el('div', 'tip-note', 'avoidBuggyIPs is on for ' + pool.name));
        } else {
            add(into, el('div', 'tip-line ok', 'Free'), el('div', 'tip-note', 'Click to give it to a service'));
        }
        return true;
    }

    function keyToIP(key) {
        var cut = key.indexOf(':');
        return { v: Number(key.slice(0, cut)), n: BigInt('0x' + key.slice(cut + 1)) };
    }

    // ----- the route an address takes ----------------------------------------

    function stop(kind, label, body, tone) {
        var node = el('li', 'stop is-' + kind + (tone ? ' ' + tone : ''));
        var mark = el('span', 'mark');
        mark.appendChild(icon(kind === 'address' ? 'pin' : kind));
        node.appendChild(mark);
        var text = el('div', 'stop-body');
        text.appendChild(el('span', 'stop-label', label));
        body.forEach(function (b) {
            if (b) text.appendChild(b);
        });
        node.appendChild(text);
        return node;
    }

    function nodeLinks(list, h) {
        var line = el('div', 'stop-line');
        list.forEach(function (n, i) {
            if (i > 0) line.appendChild(document.createTextNode(', '));
            line.appendChild(
                link(n.name, function () {
                    h.open({ kind: M.KINDS.nodes, namespace: '', name: n.name });
                }),
            );
            if (n.interfaces && n.interfaces.length) line.appendChild(el('span', 'faint', ' (' + n.interfaces.join(', ') + ')'));
        });
        return line;
    }

    // An allocated address, from the address out: the services holding it,
    // the pool, and every advertisement that carries it out of the cluster.
    // h: { open(ref) }
    function route(model, at, h) {
        var list = el('ol', 'route');
        var pool = at.pool;

        var ipLine = el('div', 'stop-line');
        ipLine.appendChild(el('code', 'big-ip', at.text));
        list.appendChild(stop('address', 'Address', [ipLine]));

        at.services.forEach(function (svc) {
            var who = el('div', 'stop-line');
            who.appendChild(
                link(svc.namespace + '/' + svc.name, function () {
                    h.open({ kind: M.KINDS.services, namespace: svc.namespace, name: svc.name });
                }),
            );
            var extra = el('div', 'stop-tags');
            if (svc.ports.length) extra.appendChild(chip(svc.ports.slice(0, 4).join('  ') + (svc.ports.length > 4 ? '  …' : ''), '', null));
            if (svc.requestedIPs.length) extra.appendChild(chip('pinned', 'info', 'pin', 'Asks for this address by annotation'));
            if (svc.shareKey) extra.appendChild(chip('shared: ' + svc.shareKey, '', 'share'));
            if (svc.localTraffic) extra.appendChild(chip('traffic policy Local', 'warn', 'info', 'Only nodes with a ready pod of this service announce it'));
            list.appendChild(stop('service', at.services.length > 1 ? 'Service (shared)' : 'Service', [who, extra]));
        });

        var poolLine = el('div', 'stop-line');
        poolLine.appendChild(
            link(pool.name, function () {
                h.open({ kind: M.KINDS.pools, namespace: pool.namespace, name: pool.name });
            }),
        );
        poolLine.appendChild(el('span', 'faint', ' · ' + pool.used + ' of ' + M.count(pool.capacity) + ' in use'));
        list.appendChild(stop('pool', 'Pool', [poolLine]));

        var hops = M.route(model, at.services[0], pool);
        if (hops.length === 0) {
            list.appendChild(
                stop('alert', 'Not advertised', [el('div', 'stop-line', 'No L2Advertisement or BGPAdvertisement covers this pool, so nothing outside the cluster is told where this address lives.')], 'error'),
            );
        }
        hops.forEach(function (hop) {
            var body = [];
            var head = el('div', 'stop-line');
            head.appendChild(
                link(hop.adv.name, function () {
                    h.open({ kind: hop.mode === 'l2' ? M.KINDS.l2 : M.KINDS.bgp, namespace: hop.adv.obj.metadata.namespace, name: hop.adv.name });
                }),
            );
            if (hop.adv.interfaces.length) head.appendChild(el('span', 'faint', ' · on ' + hop.adv.interfaces.join(', ')));
            body.push(head);

            if (hop.mode === 'l2') {
                if (hop.known) {
                    body.push(el('div', 'stop-sub', 'Answering ARP / NDP from'));
                    body.push(nodeLinks(hop.nodes, h));
                } else if (hop.candidates.length > 0) {
                    body.push(el('div', 'stop-sub', 'One of these answers, elected per address:'));
                    body.push(nodeLinks(hop.candidates.slice(0, 6), h));
                    if (hop.candidates.length > 6) body.push(el('div', 'faint', 'and ' + (hop.candidates.length - 6) + ' more'));
                } else {
                    body.push(el('div', 'stop-sub error', 'No node with a speaker is selected, so nobody answers.'));
                }
                list.appendChild(stop('l2', 'Layer 2', body));
            } else {
                if (hop.known) {
                    body.push(el('div', 'stop-sub', 'Announced from'));
                    body.push(nodeLinks(hop.nodes, h));
                } else {
                    body.push(el('div', 'stop-sub', 'Announced from ' + hop.candidates.length + ' node' + (hop.candidates.length === 1 ? '' : 's')));
                }
                if (hop.peers.length) {
                    var peers = el('div', 'stop-peers');
                    hop.peers.forEach(function (p) {
                        var row = el('div', 'peer');
                        row.appendChild(icon('peer'));
                        row.appendChild(
                            link(p.name, function () {
                                h.open({ kind: M.KINDS.peers, namespace: p.obj.metadata.namespace, name: p.name });
                            }),
                        );
                        row.appendChild(el('span', 'faint', ' ' + p.address + (p.peerASN ? ' · AS' + p.peerASN : '')));
                        peers.appendChild(row);
                    });
                    body.push(peers);
                } else {
                    body.push(el('div', 'stop-sub error', 'No BGPPeer to announce to.'));
                }
                list.appendChild(stop('bgp', 'BGP', body));
            }
        });
        return list;
    }

    // ----- patches -----------------------------------------------------------

    var OTHER = { 'metallb.io/': 'metallb.universe.tf/', 'metallb.universe.tf/': 'metallb.io/' };

    // A merge patch setting MetalLB annotations under the prefix this cluster
    // uses, and clearing the same annotation under the other one so the two
    // cannot disagree. null removes.
    function annotationPatch(model, svc, changes) {
        var have = svc.obj.metadata.annotations || {};
        var mine = model.prefix;
        var other = OTHER[mine];
        var annotations = {};
        Object.keys(changes).forEach(function (name) {
            if (changes[name] === null && have[mine + name] === undefined && have[other + name] === undefined) return;
            annotations[mine + name] = changes[name];
            if (have[other + name] !== undefined) annotations[other + name] = null;
        });
        var patch = { metadata: { annotations: annotations } };
        return patch;
    }

    // The deprecated spec field would contradict an annotation set beside it.
    function dropLegacyIP(svc, patch) {
        if (svc.obj.spec && svc.obj.spec.loadBalancerIP) patch.spec = { loadBalancerIP: null };
        return patch;
    }

    var patches = {
        movePool: function (model, svc, poolName) {
            return dropLegacyIP(svc, annotationPatch(model, svc, { 'address-pool': poolName || null, loadBalancerIPs: null }));
        },
        giveAddress: function (model, svc, text, pool) {
            return dropLegacyIP(svc, annotationPatch(model, svc, { loadBalancerIPs: text, 'address-pool': pool ? pool.name : null }));
        },
        pin: function (model, svc) {
            return annotationPatch(model, svc, { loadBalancerIPs: svc.ips.join(',') });
        },
        unpin: function (model, svc) {
            return dropLegacyIP(svc, annotationPatch(model, svc, { loadBalancerIPs: null }));
        },
        makeLoadBalancer: function () {
            return { spec: { type: 'LoadBalancer' } };
        },
        poolField: function (field, value) {
            var spec = {};
            spec[field] = value;
            return { spec: spec };
        },
    };

    // Asks the app to apply a patch. The app shows it to the user first; a
    // "no" is not an error worth showing.
    function apply(sdk, ref, patch) {
        return sdk.patch({ kind: ref.kind, namespace: ref.namespace, name: ref.name, patch: patch }).then(
            function () {
                return true;
            },
            function (err) {
                if (/declined/.test(err.message)) return false;
                throw err;
            },
        );
    }

    function serviceRef(svc) {
        return { kind: M.KINDS.services, namespace: svc.namespace, name: svc.name };
    }

    // A <select> of pools, "Automatic" first.
    function poolPicker(model, current, svc) {
        var select = el('select', 'picker');
        var auto = el('option', '', 'Automatic');
        auto.value = '';
        select.appendChild(auto);
        model.pools.forEach(function (p) {
            var option = el('option', '', p.name + ' — ' + M.count(M.free(p)) + ' free');
            option.value = p.name;
            if (svc && !M.poolServes(p, svc)) option.disabled = true;
            if (p.name === current) option.selected = true;
            select.appendChild(option);
        });
        return select;
    }

    function age(timestamp) {
        if (!timestamp) return '';
        var seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
        if (seconds < 90) return Math.round(seconds) + 's';
        if (seconds < 5400) return Math.round(seconds / 60) + 'm';
        if (seconds < 172800) return Math.round(seconds / 3600) + 'h';
        return Math.round(seconds / 86400) + 'd';
    }

    window.MetalLBKit = {
        el: el,
        add: add,
        svg: svg,
        icon: icon,
        chip: chip,
        button: button,
        link: link,
        about: about,
        ring: ring,
        meter: meter,
        fillTone: fillTone,
        fitSeats: fitSeats,
        seatMap: seatMap,
        legend: legend,
        tooltip: tooltip,
        describeSeat: describeSeat,
        keyToIP: keyToIP,
        route: route,
        patches: patches,
        apply: apply,
        serviceRef: serviceRef,
        poolPicker: poolPicker,
        age: age,
    };
})();
