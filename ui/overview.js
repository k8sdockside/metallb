// MetalLB's own overview, in place of the page the app generates for every
// plugin. It answers what the generated one does -- is this even installed
// here? -- and then what that page cannot: whether the addresses MetalLB hands
// out can actually be reached, the path they take to get there, and what
// MetalLB has been doing lately.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.MetalLB;
    var K = window.MetalLBKit;
    var el = K.el;
    var add = K.add;

    var POLL = 5000;
    var EVENTS_EVERY = 15000;
    var SUMMARY_EVERY = 30000;
    var CHARTS_EVERY = 60000;
    var HISTORY_MINUTES = 360;
    var FALLBACK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

    // The reasons MetalLB's controller and speakers give their events, for
    // clusters whose events do not name the component.
    var REASONS = ['IPAllocated', 'AllocationFailed', 'nodeAssigned', 'ClearAssignment', 'LoadBalancerFailed'];

    var state = {
        ctx: null,
        model: null,
        sig: '',
        summary: null,
        panel: null,
        events: null,
        error: '',
    };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        state.error = (err && err.message) || String(err);
        $('error').textContent = state.error;
        $('error').hidden = false;
    }

    function clearError() {
        state.error = '';
        $('error').hidden = true;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function openView(id) {
        sdk.openView(id).catch(fail);
    }

    function poolColor(i) {
        return 'var(--chart-' + Math.min(i + 1, 8) + ', ' + FALLBACK[Math.min(i, 7)] + ')';
    }

    // A series named after a pool wears that pool's colour, as it does in the
    // ring above; anything else takes the colours in order.
    function seriesColor(name, i) {
        var pools = state.model ? state.model.pools : [];
        for (var p = 0; p < pools.length; p++) {
            if (pools[p].name === name) return poolColor(p);
        }
        return poolColor(i);
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many || one + 's');
    }

    function ago(timestamp) {
        if (!timestamp) return '';
        if (Date.now() - new Date(timestamp).getTime() < 10000) return 'just now';
        return K.age(timestamp) + ' ago';
    }

    // ----- reading -----------------------------------------------------------

    function totals(model) {
        var capacity = 0n;
        var used = 0;
        model.pools.forEach(function (p) {
            capacity += p.capacity;
            used += p.used;
        });
        var ready = 0;
        var speakers = 0;
        model.nodes.forEach(function (n) {
            if (n.speaker) speakers++;
            if (n.speakerReady) ready++;
        });
        var l2 = model.advertisements.filter(function (a) {
            return a.mode === 'l2';
        }).length;
        return {
            capacity: capacity,
            used: used,
            exposed: model.services.length - model.pending.length,
            ready: ready,
            speakers: speakers,
            l2: l2,
            bgp: model.advertisements.length - l2,
            unannounced: model.pools.filter(function (p) {
                return p.used > 0 && !p.l2.length && !p.bgp.length;
            }),
        };
    }

    // Everything worth a person's attention, worst first: services with no
    // address, then what is wrong with the setup.
    function issues(model) {
        var out = [];
        model.pending.forEach(function (svc) {
            out.push({ tone: svc.diagnosis.tone === 'info' ? 'warn' : svc.diagnosis.tone, svc: svc, text: svc.diagnosis.text });
        });
        model.findings.forEach(function (f) {
            if (f.tone !== 'info') out.push(f);
        });
        var rank = { error: 0, warn: 1 };
        return out.sort(function (a, b) {
            return rank[a.tone] - rank[b.tone];
        });
    }

    function loadEvents(model) {
        var namespaces = {};
        model.services.forEach(function (s) {
            namespaces[s.namespace] = true;
        });
        var list = Object.keys(namespaces).slice(0, 25);
        return Promise.all(
            list.map(function (ns) {
                return sdk.list({ kind: M.KINDS.events, namespace: ns }).catch(function () {
                    return [];
                });
            }),
        ).then(function (answers) {
            var out = [];
            answers.forEach(function (items) {
                items.forEach(function (ev) {
                    var target = ev.involvedObject || ev.regarding || {};
                    if (target.kind !== 'Service') return;
                    var component = (ev.source && ev.source.component) || ev.reportingController || ev.reportingComponent || '';
                    if (!/metallb/i.test(component) && REASONS.indexOf(ev.reason) < 0) return;
                    out.push({
                        uid: ev.metadata.uid,
                        when: ev.lastTimestamp || ev.eventTime || (ev.series && ev.series.lastObservedTime) || ev.metadata.creationTimestamp || '',
                        type: ev.type || 'Normal',
                        reason: ev.reason || '',
                        message: ev.message || ev.note || '',
                        count: ev.count || 1,
                        namespace: target.namespace || ev.metadata.namespace,
                        name: target.name,
                    });
                });
            });
            return out
                .sort(function (a, b) {
                    return a.when < b.when ? 1 : a.when > b.when ? -1 : 0;
                })
                .slice(0, 12);
        });
    }

    // ----- the hero ----------------------------------------------------------

    function verdict(model, found) {
        var errors = found.filter(function (i) {
            return i.tone === 'error';
        }).length;
        if (found.length === 0) {
            return { tone: 'ok', icon: 'check', text: model.services.length ? 'Every address is reachable' : 'Ready to hand out addresses' };
        }
        return {
            tone: errors ? 'error' : 'warn',
            icon: 'alert',
            text: plural(found.length, 'thing needs', 'things need') + ' attention',
        };
    }

    // The sentence under the verdict, with the numbers in bold.
    function story(model, t) {
        var p = el('p', 'ov-story');
        function b(text) {
            return el('strong', '', text);
        }
        if (model.pools.length === 0) {
            add(p, 'MetalLB is running, but there is no address pool yet — nothing to hand out until there is one.');
            return p;
        }
        add(p, 'Handing out ', b(plural(t.used, 'address', 'addresses')), ' to ', b(plural(t.exposed, 'service')), ' from ', b(plural(model.pools.length, 'pool')));
        var modes = [];
        if (t.l2) modes.push('Layer 2');
        if (t.bgp) modes.push('BGP');
        if (modes.length) {
            add(p, ', announced over ', b(modes.join(' and ')));
        } else {
            add(p, ', ', el('strong', 'bad', 'announced nowhere'));
        }
        if (model.speakersKnown) {
            add(p, ' by ');
            var sp = b(t.ready + ' of ' + plural(t.speakers, 'speaker'));
            if (t.ready < t.speakers) sp.className = 'bad';
            p.appendChild(sp);
        }
        add(p, '.');
        if (model.pending.length) {
            add(p, ' ');
            p.appendChild(el('strong', 'bad', plural(model.pending.length, 'service is', 'services are') + ' still waiting'));
            add(p, ' for one.');
        }
        return p;
    }

    // The addresses in use as one ring, a slice per pool they came from. How
    // full each pool is goes in the legend beside it: pools are usually far
    // emptier than they are busy, and a ring per pool filled to its share of
    // a /16 is a ring with nothing on it.
    function orbit(model, t) {
        var wrap = el('div', 'ov-orbit');
        var size = 232;
        var mid = size / 2;
        var r = 92;
        var c = 2 * Math.PI * r;
        var svg = K.svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'ov-rings', role: 'img' });
        svg.setAttribute('aria-label', t.used + ' addresses in use across ' + model.pools.length + ' pools');
        svg.appendChild(K.svg('circle', { cx: mid, cy: mid, r: r, class: 'ov-ring-track' }));

        var holding = model.pools.filter(function (p) {
            return p.used > 0;
        });
        // A hairline between slices, unless one pool holds everything.
        var gap = holding.length > 1 ? 3 : 0;
        var start = 0;
        model.pools.forEach(function (pool, i) {
            if (pool.used === 0 || t.used === 0) return;
            var length = (pool.used / t.used) * c;
            var ring = K.svg('circle', {
                cx: mid,
                cy: mid,
                r: r,
                class: 'ov-ring',
                'stroke-dasharray': Math.max(1, length - gap) + ' ' + c,
                'stroke-dashoffset': String(-start),
                transform: 'rotate(-90 ' + mid + ' ' + mid + ')',
            });
            ring.style.stroke = poolColor(i);
            ring.style.animationDelay = i * 90 + 'ms';
            var title = K.svg('title', {});
            title.textContent = pool.name + ': ' + pool.used + ' of the ' + t.used + ' in use';
            ring.appendChild(title);
            svg.appendChild(ring);
            start += length;
        });
        wrap.appendChild(svg);

        var centre = el('div', 'ov-centre');
        add(centre, el('div', 'ov-centre-big', String(t.used)), el('div', 'ov-centre-small', 'in use of ' + M.count(t.capacity)));
        wrap.appendChild(centre);

        var legend = el('ul', 'ov-legend');
        model.pools.forEach(function (pool, i) {
            var item = el('li');
            var b = K.button('', 'ov-legend-row', null, function () {
                open({ kind: M.KINDS.pools, namespace: pool.namespace, name: pool.name });
            });
            var dot = el('i', 'dot');
            dot.style.background = poolColor(i);
            var fraction = M.share(pool.used, pool.capacity);
            b.title = pool.name + ' is ' + M.percent(fraction) + ' full';
            add(b, dot, el('span', 'ov-legend-name', pool.name), el('span', 'ov-legend-num', pool.used + ' / ' + M.count(pool.capacity)), el('span', 'ov-legend-pct ' + K.fillTone(fraction), M.percent(fraction) + ' full'));
            item.appendChild(b);
            legend.appendChild(item);
        });
        return { rings: wrap, legend: legend };
    }

    function drawHero(model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.className = 'ov-hero';
        var t = totals(model);
        var found = issues(model);
        var v = verdict(model, found);
        hero.classList.add(v.tone);

        var main = el('div', 'ov-hero-main');
        var eyebrow = el('div', 'ov-eyebrow');
        var logo = el('span', 'logo');
        logo.appendChild(K.icon('logo'));
        add(eyebrow, logo, el('span', '', 'MetalLB' + (model.version ? ' ' + model.version : '')), el('span', 'faint', '· ' + state.ctx.contextName + (model.namespace ? ' · ' + model.namespace : '')));
        main.appendChild(eyebrow);

        var head = el('h1', 'ov-verdict ' + v.tone);
        add(head, K.icon(v.icon), el('span', '', v.text));
        main.appendChild(head);
        main.appendChild(story(model, t));

        var cta = el('div', 'ov-cta');
        add(
            cta,
            K.button('Open address space', 'primary', 'grid', function () {
                openView('space');
            }),
            K.button('See how it is announced', 'ghost', 'share', function () {
                openView('routes');
            }),
        );
        main.appendChild(cta);
        hero.appendChild(main);

        if (model.pools.length) {
            var o = orbit(model, t);
            var side = el('div', 'ov-hero-side');
            add(side, o.rings, o.legend);
            hero.appendChild(side);
        }
    }

    // ----- the path ----------------------------------------------------------

    function stage(tone, iconName, label, big, small, onClick) {
        var node = K.button('', 'ov-stage ' + tone, null, onClick);
        var badge = el('span', 'ov-stage-icon');
        badge.appendChild(K.icon(iconName));
        add(node, badge, el('span', 'ov-stage-label', label), el('span', 'ov-stage-big', big), el('span', 'ov-stage-small', small));
        return node;
    }

    // A link between two stages: traffic moving along it while the stage it
    // leads to is fine, still where it is not.
    function link(tone) {
        var node = el('div', 'ov-link ' + tone);
        var svg = K.svg('svg', { viewBox: '0 0 60 12', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        svg.appendChild(K.svg('line', { x1: 0, y1: 6, x2: 60, y2: 6, class: 'ov-link-track' }));
        svg.appendChild(K.svg('line', { x1: 0, y1: 6, x2: 60, y2: 6, class: 'ov-link-flow' }));
        node.appendChild(svg);
        return node;
    }

    function drawPath(model) {
        var box = $('path');
        box.textContent = '';
        box.hidden = model.pools.length === 0;
        if (box.hidden) return;
        var t = totals(model);
        var fraction = M.share(t.used, t.capacity);

        var pending = model.pending.length;
        var steps = [
            stage('ok', 'pool', 'Pools', String(model.pools.length), M.count(t.capacity) + ' addresses', function () {
                openView('pools');
            }),
            stage(pending ? 'warn' : fraction >= 0.95 ? 'error' : fraction >= 0.8 ? 'warn' : 'ok', 'pin', 'Handed out', String(t.used), pending ? pending + ' waiting' : M.percent(fraction) + ' in use', function () {
                openView('space');
            }),
            stage(t.unannounced.length ? 'error' : model.advertisements.length ? 'ok' : 'warn', t.bgp && !t.l2 ? 'bgp' : 'l2', 'Advertised', String(model.advertisements.length), t.unannounced.length ? plural(t.unannounced.length, 'pool') + ' not announced' : [t.l2 ? 'L2 · ' + t.l2 : '', t.bgp ? 'BGP · ' + t.bgp : ''].filter(Boolean).join('  ') || 'none yet', function () {
                openView('routes');
            }),
            model.speakersKnown
                ? stage(t.ready < t.speakers ? 'error' : t.speakers ? 'ok' : 'warn', 'node', 'Speakers', t.ready + ' / ' + t.speakers, t.ready < t.speakers ? t.speakers - t.ready + ' not ready' : 'ready on ' + plural(t.speakers, 'node'), function () {
                      openView('components');
                  })
                : stage('muted', 'node', 'Speakers', '—', 'no speaker pods found', function () {
                      openView('components');
                  }),
            model.peerList.length
                ? stage('ok', 'peer', 'BGP peers', String(model.peerList.length), model.peerList.slice(0, 2).map(function (p) {
                      return p.address;
                  }).join(', '), function () {
                      openView('peers');
                  })
                : stage(t.l2 ? 'ok' : 'muted', 'l2', 'Network', 'LAN', t.l2 ? 'answered by ARP / NDP' : 'nothing announces yet', function () {
                      openView('routes');
                  }),
        ];

        steps.forEach(function (s, i) {
            if (i > 0) {
                var next = s.classList.contains('error') ? 'error' : s.classList.contains('warn') ? 'warn' : s.classList.contains('muted') ? 'muted' : 'ok';
                box.appendChild(link(next));
            }
            box.appendChild(s);
        });
    }

    // ----- attention and activity --------------------------------------------

    function drawAttention(model) {
        var box = $('attention');
        box.textContent = '';
        var found = issues(model);
        var head = el('div', 'ov-card-head');
        add(head, K.icon(found.length ? 'alert' : 'check'), el('h2', '', found.length ? 'Needs attention' : 'All clear'));
        if (found.length) head.appendChild(el('span', 'count', String(found.length)));
        box.appendChild(head);
        box.className = 'ov-card' + (found.length ? '' : ' clear');

        if (found.length === 0) {
            box.appendChild(el('p', 'ov-quiet', 'Every LoadBalancer service has an address, every pool in use is announced, and every speaker is ready.'));
            return;
        }
        var list = el('ul', 'ov-issues');
        found.slice(0, 6).forEach(function (f) {
            var item = el('li', 'ov-issue ' + f.tone);
            var body = el('div');
            if (f.svc) {
                var title = el('div', 'ov-issue-title');
                add(
                    title,
                    K.link(f.svc.namespace + '/' + f.svc.name, function () {
                        open(K.serviceRef(f.svc));
                    }),
                    el('span', 'faint', ' has no address'),
                );
                body.appendChild(title);
            }
            body.appendChild(el('div', 'ov-issue-text', f.text));
            item.appendChild(body);
            if (f.ref) {
                var go = K.button('', 'icon-button', 'open', function () {
                    open(f.ref);
                });
                go.title = 'Open';
                go.setAttribute('aria-label', 'Open');
                item.appendChild(go);
            }
            list.appendChild(item);
        });
        box.appendChild(list);
        var more = K.button(found.length > 6 ? 'All ' + found.length + ' in the address space' : 'Fix them in the address space', 'ghost small', 'arrow', function () {
            openView('space');
        });
        box.appendChild(more);
    }

    // What an event says, in fewer words: MetalLB's messages quote the
    // addresses and node names they are about.
    function eventText(ev) {
        var quoted = [];
        ev.message.replace(/"([^"]+)"/g, function (_, v) {
            quoted.push(v);
        });
        if (ev.reason === 'IPAllocated' && quoted.length) return 'was given ' + quoted.join(', ');
        if (ev.reason === 'nodeAssigned' && quoted.length) {
            var proto = quoted[1] === 'layer2' ? 'Layer 2' : quoted[1] === 'bgp' ? 'BGP' : quoted[1] || '';
            return 'is announced from ' + quoted[0] + (proto ? ' over ' + proto : '');
        }
        // The service is already named beside it.
        var failed = /^Failed to allocate IP for "[^"]*":\s*/.exec(ev.message);
        if (failed) return 'could not get an address: ' + ev.message.slice(failed[0].length);
        return ev.message;
    }

    function eventIcon(ev) {
        if (ev.type === 'Warning') return 'alert';
        if (ev.reason === 'IPAllocated') return 'pin';
        if (ev.reason === 'nodeAssigned') return 'l2';
        return 'activity';
    }

    function drawActivity() {
        var box = $('activity');
        box.textContent = '';
        var head = el('div', 'ov-card-head');
        add(head, K.icon('activity'), el('h2', '', 'Recent activity'));
        box.appendChild(head);

        if (state.events === null) {
            box.appendChild(el('p', 'ov-quiet', 'Reading events…'));
            return;
        }
        if (state.events.length === 0) {
            box.appendChild(el('p', 'ov-quiet', 'Nothing from MetalLB lately. Kubernetes keeps events for about an hour, so a quiet cluster reads as an empty list.'));
            return;
        }
        var list = el('ol', 'ov-timeline');
        state.events.forEach(function (ev) {
            var item = el('li', 'ov-event' + (ev.type === 'Warning' ? ' warn' : ''));
            var mark = el('span', 'ov-event-mark');
            mark.appendChild(K.icon(eventIcon(ev)));
            item.appendChild(mark);
            var body = el('div', 'ov-event-body');
            var line = el('div', 'ov-event-line');
            add(
                line,
                K.link(ev.namespace + '/' + ev.name, function () {
                    open({ kind: M.KINDS.services, namespace: ev.namespace, name: ev.name });
                }),
                ' ',
                el('span', '', eventText(ev)),
            );
            body.appendChild(line);
            var meta = el('div', 'ov-event-meta', ago(ev.when) + (ev.count > 1 ? ' · ' + ev.count + '×' : '') + (ev.reason ? ' · ' + ev.reason : ''));
            body.appendChild(meta);
            item.appendChild(body);
            list.appendChild(item);
        });
        box.appendChild(list);
    }

    // ----- history -----------------------------------------------------------

    function formatValue(v, unit) {
        if (unit === 'count') return String(Math.round(v));
        return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
    }

    // One chart as an area per series: y from zero, a gap where Prometheus
    // had no sample, and each series' latest value written beside it.
    function sparkChart(chart) {
        var card = el('article', 'ov-chart');
        var head = el('div', 'ov-chart-head');
        head.appendChild(el('h3', '', chart.label));
        if (chart.description) head.title = chart.description;
        card.appendChild(head);

        var series = chart.series.filter(function (s) {
            return s.points.length > 0;
        });
        if (chart.error || series.length === 0) {
            card.appendChild(el('p', 'ov-quiet', chart.error || 'No data for this window. ' + (chart.description || '')));
            return card;
        }

        var minT = Infinity;
        var maxT = -Infinity;
        var maxV = 0;
        series.forEach(function (s) {
            s.points.forEach(function (p) {
                minT = Math.min(minT, p.t);
                maxT = Math.max(maxT, p.t);
                if (isFinite(p.v)) maxV = Math.max(maxV, p.v);
            });
        });
        if (maxT === minT) maxT = minT + 1;
        var top = maxV > 0 ? maxV * 1.15 : 1;
        var W = 600;
        var H = 140;
        var x = function (t) {
            return ((t - minT) / (maxT - minT)) * W;
        };
        var y = function (v) {
            return H - (v / top) * H;
        };
        // Points more than this far apart are a gap, not a line.
        var step = (maxT - minT) / 60;

        var svg = K.svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: 'ov-spark' });
        [0.25, 0.5, 0.75].forEach(function (f) {
            svg.appendChild(K.svg('line', { x1: 0, x2: W, y1: H * f, y2: H * f, class: 'ov-grid' }));
        });
        series.forEach(function (s, i) {
            var runs = [];
            var run = [];
            s.points.forEach(function (p, j) {
                var gapHere = j > 0 && p.t - s.points[j - 1].t > step * 3;
                if (!isFinite(p.v) || gapHere) {
                    if (run.length) runs.push(run);
                    run = [];
                    if (!isFinite(p.v)) return;
                }
                run.push(p);
            });
            if (run.length) runs.push(run);
            var colour = seriesColor(s.name, i);
            runs.forEach(function (r) {
                var line = r
                    .map(function (p, j) {
                        return (j ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1);
                    })
                    .join(' ');
                var area = line + ' L' + x(r[r.length - 1].t).toFixed(1) + ' ' + H + ' L' + x(r[0].t).toFixed(1) + ' ' + H + ' Z';
                var fill = K.svg('path', { d: area, class: 'ov-area' });
                fill.style.fill = colour;
                svg.appendChild(fill);
                var stroke = K.svg('path', { d: line, class: 'ov-line' });
                stroke.style.stroke = colour;
                svg.appendChild(stroke);
            });
        });
        card.appendChild(svg);

        var legend = el('div', 'ov-chart-legend');
        series.forEach(function (s, i) {
            var last = s.points[s.points.length - 1];
            var key = el('span', 'ov-chart-key');
            var dot = el('i', 'dot');
            dot.style.background = seriesColor(s.name, i);
            add(key, dot, el('span', '', s.name || chart.label), el('strong', '', formatValue(last.v, chart.unit)));
            legend.appendChild(key);
        });
        card.appendChild(legend);
        return card;
    }

    function drawHistory() {
        var box = $('history');
        box.textContent = '';
        var panel = state.panel;
        box.hidden = !panel || !panel.attached;
        if (box.hidden) return;
        var head = el('div', 'ov-section-head');
        add(head, K.icon('chart'), el('h2', '', 'Over the last ' + Math.round(HISTORY_MINUTES / 60) + ' hours'));
        box.appendChild(head);
        if (!panel.source.available) {
            box.appendChild(
                el('p', 'ov-quiet', 'No Prometheus was found in this cluster, so there is no history to draw. ' + (panel.source.error || 'Set one in the cluster settings panel if it lives somewhere the app did not look.')),
            );
            return;
        }
        var row = el('div', 'ov-chart-row');
        panel.charts.forEach(function (chart) {
            row.appendChild(sparkChart(chart));
        });
        box.appendChild(row);
        if (panel.source.describe) box.appendChild(el('p', 'ov-source', 'From ' + panel.source.describe));
    }

    // ----- the foot ----------------------------------------------------------

    var DESTINATIONS = [
        { id: 'space', label: 'Address space', icon: 'grid' },
        { id: 'routes', label: 'Announcements', icon: 'share' },
        { id: 'pools', label: 'Pools', icon: 'pool' },
        { id: 'l2', label: 'L2 advertisements', icon: 'l2' },
        { id: 'bgp', label: 'BGP advertisements', icon: 'bgp' },
        { id: 'peers', label: 'BGP peers', icon: 'peer' },
        { id: 'components', label: "MetalLB's pods", icon: 'node' },
    ];

    function drawFoot() {
        var box = $('foot');
        box.textContent = '';
        box.hidden = false;

        var go = el('div', 'ov-go');
        DESTINATIONS.forEach(function (d) {
            go.appendChild(
                K.button(d.label, 'ov-go-tile', d.icon, function () {
                    openView(d.id);
                }),
            );
        });
        box.appendChild(go);

        if (state.summary && state.summary.requirements.length) {
            var reqs = el('div', 'ov-reqs');
            reqs.appendChild(el('span', 'ov-reqs-label', 'This cluster serves'));
            state.summary.requirements.forEach(function (r) {
                var tone = r.error ? 'warn' : r.served ? 'ok' : r.optional ? 'muted' : 'error';
                var c = K.chip(r.label, tone, r.error ? 'alert' : r.served ? 'check' : 'close', r.error || r.kind);
                reqs.appendChild(c);
            });
            box.appendChild(reqs);
        }
        add(box, K.about(sdk, state.ctx && state.ctx.plugin, fail));
    }

    // ----- not here, or not reachable ----------------------------------------

    function drawAbsent(summary, model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.className = 'ov-hero absent';
        ['path', 'columns', 'history', 'foot'].forEach(function (id) {
            $(id).hidden = true;
        });

        var main = el('div', 'ov-hero-main');
        var art = el('div', 'empty-art');
        art.appendChild(K.icon('logo'));
        main.appendChild(art);

        var unreachable = summary && !summary.checked;
        main.appendChild(el('h1', 'ov-verdict', unreachable ? 'This cluster did not answer' : 'MetalLB is not installed in ' + state.ctx.contextName));
        main.appendChild(
            el(
                'p',
                'ov-story',
                unreachable
                    ? 'Whether MetalLB is here could not be checked, which is not the same as it being absent. ' + (summary.error || '')
                    : 'This cluster does not serve the kinds every MetalLB install has, so LoadBalancer services here get their addresses from something else — or not at all.',
            ),
        );
        if (summary && summary.requirements.length) {
            var list = el('ul', 'ov-req-list');
            summary.requirements.forEach(function (r) {
                var item = el('li', r.served ? 'ok' : r.optional ? 'muted' : 'error');
                add(item, K.icon(r.served ? 'check' : 'close'), el('span', '', r.label), el('code', 'faint', r.kind.replace(/^crd:/, '')));
                if (r.optional) item.appendChild(el('span', 'faint small', 'optional'));
                list.appendChild(item);
            });
            main.appendChild(list);
        } else if (model && model.missing) {
            main.appendChild(el('p', 'faint small', model.missing));
        }
        if (!unreachable) {
            var cta = el('div', 'ov-cta');
            cta.appendChild(
                K.button('How to install MetalLB', 'primary', 'open', function () {
                    sdk.openUrl('https://metallb.io/installation/').catch(fail);
                }),
            );
            main.appendChild(cta);
        }
        add(main, K.about(sdk, state.ctx && state.ctx.plugin, fail));
        hero.appendChild(main);
    }

    // ----- putting it together -----------------------------------------------

    function render() {
        var model = state.model;
        var summary = state.summary;
        if (summary && (!summary.checked || !summary.installed)) {
            drawAbsent(summary, model);
            return;
        }
        if (!model) return;
        if (!model.installed) {
            drawAbsent(summary, model);
            return;
        }
        $('columns').hidden = false;
        drawHero(model);
        drawPath(model);
        drawAttention(model);
        drawActivity();
        drawHistory();
        drawFoot();
    }

    function every(ms, fn) {
        function run() {
            Promise.resolve()
                .then(fn)
                .catch(fail)
                .then(function () {
                    setTimeout(run, ms);
                });
        }
        run();
    }

    sdk.ready()
        .then(function (context) {
            state.ctx = context;

            every(POLL, function () {
                return M.load(sdk).then(function (model) {
                    clearError();
                    if (model.sig === state.sig) return;
                    var first = !state.model;
                    state.model = model;
                    state.sig = model.sig;
                    render();
                    // The events follow the services they are about, so the
                    // first read waits for the first model.
                    if (first) refreshEvents();
                });
            });
            every(SUMMARY_EVERY, function () {
                return sdk.summary().then(function (summary) {
                    var changed = JSON.stringify(summary) !== JSON.stringify(state.summary);
                    state.summary = summary;
                    if (changed) render();
                });
            });
            every(CHARTS_EVERY, function () {
                if (!sdk.charts) return null;
                return sdk.charts({ minutes: HISTORY_MINUTES }).then(function (panel) {
                    state.panel = panel;
                    if (state.model && state.model.installed) drawHistory();
                });
            });
            setInterval(refreshEvents, EVENTS_EVERY);
        })
        .catch(fail);

    function refreshEvents() {
        if (!state.model || !state.model.installed) return;
        loadEvents(state.model)
            .then(function (events) {
                var changed = JSON.stringify(events) !== JSON.stringify(state.events);
                state.events = events;
                if (changed) drawActivity();
            })
            .catch(fail);
    }
})();
