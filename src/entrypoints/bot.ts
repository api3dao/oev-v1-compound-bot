import '../bigint-monkeypatch';
import { Compound3Bot } from '../oev-liquidation';

const compound3Bot = new Compound3Bot();
compound3Bot.start();
