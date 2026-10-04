package kr.kimmi.mingyeol.chzzkapi;

import ch.njol.skript.Skript;
import ch.njol.skript.lang.Effect;
import ch.njol.skript.lang.Expression;
import ch.njol.skript.lang.SkriptParser.ParseResult;
import ch.njol.util.Kleenean;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;
import org.jetbrains.annotations.Nullable;

/** Registers CHZZK-only Skript syntax without depending on the Discord app. */
final class ChzzkSkriptEffects {
    private ChzzkSkriptEffects() { }

    static void register(MingyeolChzzkApiPlugin plugin) {
        Skript.registerEffect(Link.class, "chzzk_link %player%", "chzzk link %player%");
        Skript.registerEffect(RefreshStatus.class, "chzzk_refresh_status %player%", "chzzk refresh status of %player%");
        Skript.registerEffect(RefreshOwnerReadData.class, "chzzk_refresh_owner_data", "chzzk refresh owner data");
        Link.plugin = plugin;
        RefreshStatus.plugin = plugin;
        RefreshOwnerReadData.plugin = plugin;
    }

    public static final class Link extends Effect {
        private static MingyeolChzzkApiPlugin plugin;
        private Expression<Player> player;

        @Override
        @SuppressWarnings("unchecked")
        public boolean init(Expression<?>[] expressions, int matchedPattern, Kleenean isDelayed, ParseResult parseResult) {
            player = (Expression<Player>) expressions[0];
            return true;
        }

        @Override
        protected void execute(Event event) {
            Player target = player.getSingle(event);
            if (target != null) plugin.beginLink(target);
        }

        @Override
        public String toString(@Nullable Event event, boolean debug) {
            return "chzzk_link";
        }
    }

    public static final class RefreshStatus extends Effect {
        private static MingyeolChzzkApiPlugin plugin;
        private Expression<Player> player;

        @Override
        @SuppressWarnings("unchecked")
        public boolean init(Expression<?>[] expressions, int matchedPattern, Kleenean isDelayed, ParseResult parseResult) {
            player = (Expression<Player>) expressions[0];
            return true;
        }

        @Override
        protected void execute(Event event) {
            Player target = player.getSingle(event);
            if (target != null) plugin.refreshViewerStatus(target);
        }

        @Override
        public String toString(@Nullable Event event, boolean debug) { return "chzzk_refresh_status"; }
    }

    public static final class RefreshOwnerReadData extends Effect {
        private static MingyeolChzzkApiPlugin plugin;

        @Override
        public boolean init(Expression<?>[] expressions, int matchedPattern, Kleenean isDelayed, ParseResult parseResult) { return true; }

        @Override
        protected void execute(Event event) { plugin.refreshOwnerReadData(); }

        @Override
        public String toString(@Nullable Event event, boolean debug) { return "chzzk_refresh_owner_data"; }
    }
}
