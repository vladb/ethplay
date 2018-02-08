const fetch = require('isomorphic-fetch');

const KRAKEN_TICKER_URL = 'https://api.kraken.com/0/public/Ticker?pair=EOSETH';
const KRAKEN_DEPTH_URL = 'https://api.kraken.com/0/public/Depth?pair=EOSETH';

class KrakenProvider {
    constructor() {
        this.providerName = 'kraken';
    }

    async watch() {
        const marketPrice = await this.getPrice();
        const marketDepth = await this.getVolume(currentMarketPrice);

        return {
            marketPrice,
            marketDepth,
        };
    }
    
    getPrice() {
        return fetch(KRAKEN_TICKER_URL)
            .then(res => res.json())
            .then(res => parseFloat(res.result.EOSETH.c[0]))
            .catch(e => console.log(`${this.providerName} error: could not fetch market price`));
    }

    getVolume(price) {
        return fetch(KRAKEN_DEPTH_URL)
            .then(res => res.json())
            .then(res => res.result.EOSETH.bids)
            .then(bids => bids.reduce((a, v) => {
                v[0] = parseFloat(v[0]);
                v[1] = parseFloat(v[1]);

                if(v[0] >= price) {
                    a += v[0] * v[1];
                }

                return a;
            }, 0))
            .then(vol => vol.toFixed(0))
            .catch(e => console.log(`${this.providerName} error: could not fetch market depth`));
    }
}

module.exports = KrakenProvider;
