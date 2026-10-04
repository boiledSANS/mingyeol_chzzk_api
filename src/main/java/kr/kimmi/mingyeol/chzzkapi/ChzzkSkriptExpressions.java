package kr.kimmi.mingyeol.chzzkapi;

import ch.njol.skript.Skript;
import ch.njol.skript.lang.Expression;
import ch.njol.skript.lang.ExpressionType;
import ch.njol.skript.lang.SkriptParser.ParseResult;
import ch.njol.skript.lang.util.SimpleExpression;
import ch.njol.skript.variables.Variables;
import ch.njol.util.Kleenean;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;
import org.jetbrains.annotations.Nullable;

/** Read-only Skript expressions backed by values synchronized by the plugin. */
final class ChzzkSkriptExpressions {
    private ChzzkSkriptExpressions() { }

    static void register() {
        Skript.registerExpression(Subscriber.class, Boolean.class, ExpressionType.SIMPLE,
                "chzzk subscriber status of %player%", "chzzk subscriber of %player%");
        Skript.registerExpression(Follower.class, Boolean.class, ExpressionType.SIMPLE,
                "chzzk follower status of %player%", "chzzk follower of %player%");
        Skript.registerExpression(SubscriberTier.class, String.class, ExpressionType.SIMPLE,
                "chzzk subscriber tier of %player%");
        Skript.registerExpression(SubscriberMonths.class, Long.class, ExpressionType.SIMPLE,
                "chzzk subscriber months of %player%");
        Skript.registerExpression(OwnerReadJson.class, String.class, ExpressionType.SIMPLE,
                "chzzk owner read json %string%");
    }

    private abstract static class PlayerExpression<T> extends SimpleExpression<T> {
        protected Expression<Player> player;

        @Override
        @SuppressWarnings("unchecked")
        public boolean init(Expression<?>[] expressions, int matchedPattern, Kleenean isDelayed, ParseResult parseResult) {
            player = (Expression<Player>) expressions[0];
            return true;
        }

        protected @Nullable Object variable(Event event, String prefix) {
            Player target = player.getSingle(event);
            return target == null ? null : Variables.getVariable(prefix + target.getUniqueId(), null, false);
        }

        @Override public boolean isSingle() { return true; }
        @Override public String toString(@Nullable Event event, boolean debug) { return "chzzk player status"; }
    }

    public static final class Subscriber extends PlayerExpression<Boolean> {
        @Override protected Boolean[] get(Event event) { return new Boolean[] { Boolean.TRUE.equals(variable(event, "chzzk_subscriber::")) }; }
        @Override public Class<? extends Boolean> getReturnType() { return Boolean.class; }
    }

    public static final class Follower extends PlayerExpression<Boolean> {
        @Override protected Boolean[] get(Event event) { return new Boolean[] { Boolean.TRUE.equals(variable(event, "chzzk_follower::")) }; }
        @Override public Class<? extends Boolean> getReturnType() { return Boolean.class; }
    }

    public static final class SubscriberTier extends PlayerExpression<String> {
        @Override protected String[] get(Event event) {
            Object value = variable(event, "chzzk_subscriber_tier::");
            return value == null ? new String[0] : new String[] { String.valueOf(value) };
        }
        @Override public Class<? extends String> getReturnType() { return String.class; }
    }

    public static final class SubscriberMonths extends PlayerExpression<Long> {
        @Override protected Long[] get(Event event) {
            Object value = variable(event, "chzzk_subscriber_months::");
            if (value instanceof Number number) return new Long[] { number.longValue() };
            return new Long[0];
        }
        @Override public Class<? extends Long> getReturnType() { return Long.class; }
    }

    public static final class OwnerReadJson extends SimpleExpression<String> {
        private Expression<String> resource;

        @Override
        @SuppressWarnings("unchecked")
        public boolean init(Expression<?>[] expressions, int matchedPattern, Kleenean isDelayed, ParseResult parseResult) {
            resource = (Expression<String>) expressions[0];
            return true;
        }

        @Override protected String[] get(Event event) {
            String value = resource.getSingle(event);
            if (value == null || !value.matches("channel|managers|followers|subscribers|live-settings|chat-settings|restrictions")) return new String[0];
            Object stored = Variables.getVariable("chzzk_read_json::" + value, null, false);
            return stored == null ? new String[0] : new String[] { String.valueOf(stored) };
        }

        @Override public boolean isSingle() { return true; }
        @Override public Class<? extends String> getReturnType() { return String.class; }
        @Override public String toString(@Nullable Event event, boolean debug) { return "chzzk owner read json"; }
    }
}
