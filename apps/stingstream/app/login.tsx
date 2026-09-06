import { Platform } from "react-native";
import { LoginScreen } from "@/components/login/LoginScreen";
import { TVLogin } from "@/components/login/TVLogin";

const LoginPage: React.FC = () => {
  // The ten-foot sign-in is its own screen, with its own focus rules and its own code-first
  // flow (WP-TV-LOGIN); nothing about the phone/web card applies to a remote control.
  if (Platform.isTV) {
    return <TVLogin />;
  }

  return <LoginScreen />;
};

export default LoginPage;
