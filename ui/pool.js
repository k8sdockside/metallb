// An IPAddressPool's panel: how full it is, its addresses as a seat map, who
// holds each one, what announces it -- and its two switches.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.MetalLB;
    var K = window.MetalLBKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;

    var state = { ctx: null, sig: '', model: null, pool: null, cols: 16, cell: 13 };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        $('error').textContent = (err && err.message) || String(err);
        $('error').hidden = false;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function poolRef(pool) {
        return { kind: M.KINDS.pools, namespace: pool.namespace, name: pool.name };
    }

    function toggle(pool, field, value, text) {
        K.apply(sdk, poolRef(pool), K.patches.poolField(field, value))
            .then(function (done) {
                if (!done) return;
                var note = el('div', 'notice');
                add(note, K.icon('check'), el('span', '', text));
                $('root').insertBefore(note, $('root').firstChild);
                setTimeout(function () {
                    note.remove();
                }, 5000);
            })
            .catch(fail);
    }

    function draw(model, pool) {
        var root = $('root');
        tip.hidden = true;
        root.textContent = '';

        var fraction = M.share(pool.used, pool.capacity);
        var head = el('div', 'pool-panel-head');
        var gauge = K.ring(fraction, 52, K.fillTone(fraction), M.percent(fraction) + ' in use');
        var nums = el('div', 'stat-nums');
        add(nums, el('div', 'stat-big', pool.used + ' / ' + M.count(pool.capacity)), el('div', 'stat-small', M.percent(fraction) + ' in use · ' + M.count(M.free(pool)) + ' free'));
        add(head, gauge, nums);
        root.appendChild(head);

        var tags = el('div', 'pool-tags');
        tags.appendChild(pool.autoAssign ? K.chip('auto-assign', 'ok', 'check') : K.chip('on request only', 'info', 'pin'));
        if (pool.avoidBuggy) tags.appendChild(K.chip('skips .0 and .255', 'muted'));
        if (pool.l2.length) tags.appendChild(K.chip('L2 · ' + pool.l2.join(', '), 'l2', 'l2'));
        if (pool.bgp.length) tags.appendChild(K.chip('BGP · ' + pool.bgp.join(', '), 'bgp', 'bgp'));
        if (!pool.l2.length && !pool.bgp.length) tags.appendChild(K.chip('not advertised', 'error', 'alert', 'No L2Advertisement or BGPAdvertisement selects this pool'));
        if (pool.onlyNamespaces.length) tags.appendChild(K.chip('only ' + pool.onlyNamespaces.join(', '), 'muted'));
        root.appendChild(tags);

        root.appendChild(K.seatMap(pool, model, { cols: state.cols, cell: state.cell, selected: '', hits: null }));
        root.appendChild(K.legend(pool, model));

        var holders = [];
        model.allocations.forEach(function (at) {
            if (at.pool === pool) holders.push(at);
        });
        holders.sort(function (a, b) {
            if (a.ip.v !== b.ip.v) return a.ip.v - b.ip.v;
            return a.ip.n < b.ip.n ? -1 : a.ip.n > b.ip.n ? 1 : 0;
        });
        if (holders.length) {
            root.appendChild(el('h3', 'mini-title', 'Handed out'));
            var list = el('ul', 'directory compact');
            holders.forEach(function (at) {
                at.services.forEach(function (s) {
                    var b = K.button('', 'dir-row', null, function () {
                        open(K.serviceRef(s));
                    });
                    var dot = el('i', 'dot');
                    dot.style.background = model.colors[s.namespace];
                    add(b, dot, el('code', 'dir-ip', at.text), el('span', 'dir-who', s.name), el('span', 'dir-ns faint', s.namespace));
                    var item = el('li');
                    item.appendChild(b);
                    list.appendChild(item);
                });
            });
            root.appendChild(list);
        }

        if (state.ctx.write) {
            var box = el('div', 'svc-controls');
            var auto = el('div', 'control');
            add(
                auto,
                el('span', 'control-value', pool.autoAssign ? 'Any LoadBalancer service may be given an address from here.' : 'Only services that ask for this pool get its addresses.'),
                K.button(pool.autoAssign ? 'Only on request' : 'Assign automatically', 'small', null, function () {
                    toggle(pool, 'autoAssign', !pool.autoAssign, pool.autoAssign ? pool.name + ' now only serves services that ask for it.' : pool.name + ' now hands out addresses to any service.');
                }),
            );
            box.appendChild(auto);
            if (pool.families.indexOf(4) >= 0) {
                var buggy = el('div', 'control');
                add(
                    buggy,
                    el('span', 'control-value', pool.avoidBuggy ? 'Addresses ending in .0 and .255 are skipped.' : 'Addresses ending in .0 and .255 are handed out like any other.'),
                    K.button(pool.avoidBuggy ? 'Use them too' : 'Skip them', 'small', null, function () {
                        toggle(pool, 'avoidBuggyIPs', !pool.avoidBuggy, pool.avoidBuggy ? pool.name + ' hands out .0 and .255 again.' : pool.name + ' now skips .0 and .255.');
                    }),
                );
                box.appendChild(buggy);
            }
            root.appendChild(box);
        }
    }

    function measure() {
        // The panel's own padding comes off the width the map gets.
        var fit = K.fitSeats(document.body.clientWidth - 28);
        if (fit.cols !== state.cols || fit.cell !== state.cell) {
            state.cols = fit.cols;
            state.cell = fit.cell;
            if (state.model && state.pool) draw(state.model, state.pool);
        }
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var pool = model.poolNamed(state.ctx.object.name);
                if (!pool) {
                    $('root').textContent = '';
                    $('root').appendChild(el('p', 'faint', 'This pool could not be read.'));
                    return;
                }
                if (model.sig === state.sig) return;
                state.sig = model.sig;
                state.model = model;
                state.pool = pool;
                draw(model, pool);
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    var tip = K.tooltip($('root'), function (seat, into) {
        return state.pool ? K.describeSeat(state.model, state.pool, seat, into) : false;
    });
    $('root').addEventListener('click', function (event) {
        var seat = event.target.closest && event.target.closest('.seat');
        if (!seat || !state.model || !seat.dataset.key) return;
        var at = state.model.allocations.get(seat.dataset.key);
        if (at) open(K.serviceRef(at.services[0]));
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(document.body);

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            if (!context.object) {
                fail(new Error('This page is a panel, drawn for one IPAddressPool.'));
                return;
            }
            measure();
            tick();
        })
        .catch(fail);
})();
