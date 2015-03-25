/**
 * Copyright 2015, Yahoo! Inc.
 * Copyrights licensed under the New BSD License. See the accompanying LICENSE file for terms.
 */
'use strict';
var React = require('react');
var NavLink = require('flux-router-component').NavLink;

var Component = React.createClass({
    render: function () {
        return (
            <div id="404" className="D-tb W-100% Bdb-1 Pos-r">
                <div className="D-tbc Va-m Bgz-cv Ov-h Pos-r W-100% Start-0">
                    <div className="Mx-a W-65% Pos-r Ov-h Fw-300">
                        <h1>Not found</h1>
                        <p>Sorry we could not find that resource.</p>
                        <p><NavLink routeName="home">Back to the home page.</NavLink></p>
                    </div>
                </div>
            </div>
        );
    }
});

module.exports = Component;